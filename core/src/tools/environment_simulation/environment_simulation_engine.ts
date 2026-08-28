/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {isEqual} from 'lodash-es';

import {Context} from '../../agents/context.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {sleep} from '../../utils/async_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {SeededRandom} from '../../utils/random_utils.js';
import {BaseTool} from '../base_tool.js';

import {
  EnvironmentSimulationConfig,
  MockStrategyType,
  ResolvedEnvironmentSimulationConfig,
  ResolvedToolSimulationConfig,
  resolveEnvironmentSimulationConfig,
} from './environment_simulation_config.js';
import {
  MockStrategy,
  StateStore,
  TracingMockStrategy,
} from './strategies/base.js';
import {ToolSpecMockStrategy} from './strategies/tool_spec_mock_strategy.js';
import {ToolConnectionAnalyzer} from './tool_connection_analyzer.js';
import {ToolConnectionMap} from './tool_connection_map.js';

const MILLISECONDS_PER_SECOND = 1000;

function createMockStrategy(
  mockStrategyType: MockStrategyType,
  llmName: string,
  llmConfig: GenerateContentConfig,
): MockStrategy {
  switch (mockStrategyType) {
    case MockStrategyType.MOCK_STRATEGY_TOOL_SPEC:
      return new ToolSpecMockStrategy(llmName, llmConfig);
    case MockStrategyType.MOCK_STRATEGY_TRACING:
      return new TracingMockStrategy();
    default:
      throw new Error(`Unknown mock strategy type: ${mockStrategyType}`);
  }
}

function matchesArgs(
  matchArgs: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): boolean {
  if (!matchArgs) {
    return true;
  }
  return Object.entries(matchArgs).every(([key, value]) =>
    isEqual(args[key], value),
  );
}

/**
 * Decides what a simulated tool call returns.
 *
 * The engine is meant to live for one run: it holds the state store that lets
 * a consuming tool see an identifier a creating tool minted, and that store
 * grows with every entity the model mints. It has no eviction, so do not share
 * one engine across a whole process.
 *
 * @experimental
 */
@experimental
export class EnvironmentSimulationEngine {
  private readonly config: ResolvedEnvironmentSimulationConfig;
  private readonly toolSimulationConfigs: Map<
    string,
    ResolvedToolSimulationConfig
  >;
  private readonly analyzer: ToolConnectionAnalyzer;
  private readonly usesMockStrategy: boolean;
  private readonly stateStore: StateStore = {};
  private readonly random = new SeededRandom();
  private analysis?: Promise<void>;
  private toolConnectionMap?: ToolConnectionMap;

  /**
   * @param config The environment to simulate.
   * @throws If the config is invalid. See
   *     {@link resolveEnvironmentSimulationConfig}.
   */
  constructor(config: EnvironmentSimulationConfig) {
    this.config = resolveEnvironmentSimulationConfig(config);
    this.toolSimulationConfigs = new Map(
      this.config.toolSimulationConfigs.map((toolConfig) => [
        toolConfig.toolName,
        toolConfig,
      ]),
    );
    this.usesMockStrategy = this.config.toolSimulationConfigs.some(
      (toolConfig) =>
        toolConfig.mockStrategyType !==
        MockStrategyType.MOCK_STRATEGY_UNSPECIFIED,
    );
    this.analyzer = new ToolConnectionAnalyzer(
      this.config.simulationModel,
      this.config.simulationModelConfiguration,
    );
  }

  /**
   * Simulates one tool call.
   *
   * @param tool The tool the agent called.
   * @param args The arguments the agent called it with.
   * @param toolContext The context of the call.
   * @return The simulated response, or `undefined` to let the real tool run.
   */
  async simulate(
    tool: BaseTool,
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<Record<string, unknown> | undefined> {
    const toolSimulationConfig = this.toolSimulationConfigs.get(tool.name);
    if (!toolSimulationConfig) {
      return undefined;
    }

    if (this.usesMockStrategy) {
      // Parallel function calls share one engine, so the analysis is memoized
      // as a promise: a second caller awaits the first analysis instead of
      // starting its own.
      this.analysis ??= this.runAnalysis(toolContext);
      await this.analysis;
    }

    const injected = await this.applyInjections(toolSimulationConfig, args);
    if (injected) {
      return injected;
    }

    if (
      toolSimulationConfig.mockStrategyType ===
      MockStrategyType.MOCK_STRATEGY_UNSPECIFIED
    ) {
      logger.warn(
        `Tool '${tool.name}' did not hit any injection config and has no mock` +
          ' strategy configured. Returning no-op.',
      );
      return undefined;
    }

    const strategy = createMockStrategy(
      toolSimulationConfig.mockStrategyType,
      this.config.simulationModel,
      this.config.simulationModelConfiguration,
    );
    return strategy.mock({
      tool,
      args,
      toolContext,
      toolConnectionMap: this.toolConnectionMap,
      stateStore: this.stateStore,
      environmentData: this.config.environmentData,
      tracing: this.config.tracing,
    });
  }

  private async runAnalysis(toolContext: Context): Promise<void> {
    const agent = toolContext.invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }
    const tools = await agent.canonicalTools(toolContext);
    this.toolConnectionMap = await this.analyzer.analyze(tools);
  }

  private async applyInjections(
    toolSimulationConfig: ResolvedToolSimulationConfig,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    for (const injectionConfig of toolSimulationConfig.injectionConfigs) {
      if (!matchesArgs(injectionConfig.matchArgs, args)) {
        continue;
      }
      if (injectionConfig.randomSeed !== undefined) {
        this.random.seed(injectionConfig.randomSeed);
      }
      if (this.random.next() >= injectionConfig.injectionProbability) {
        continue;
      }
      await sleep(
        injectionConfig.injectedLatencySeconds * MILLISECONDS_PER_SECOND,
      );
      if (injectionConfig.injectedError) {
        return {
          error_code: injectionConfig.injectedError.injectedHttpErrorCode,
          error_message: injectionConfig.injectedError.errorMessage,
        };
      }
      return injectionConfig.injectedResponse;
    }
    return undefined;
  }
}
