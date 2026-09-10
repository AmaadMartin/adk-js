/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {isEqual} from 'lodash-es';

import {Context} from '../../agents/context.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';
import {logger} from '../../utils/logger.js';
import {createSeededRandom, SeededRandom} from '../../utils/random_utils.js';
import {BaseTool} from '../base_tool.js';

import {
  EnvironmentSimulationConfig,
  MockStrategy,
  ToolSimulationConfig,
} from './environment_simulation_config.js';
import {BaseMockStrategy, TracingMockStrategy} from './strategies/base.js';
import {ToolSpecMockStrategy} from './strategies/tool_spec_mock_strategy.js';
import {ToolConnectionAnalyzer} from './tool_connection_analyzer.js';
import {ToolConnectionMap} from './tool_connection_map.js';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Throws unless the experimental `ENVIRONMENT_SIMULATION` feature is on.
 *
 * The config module gates its factories the same way. adk-python's
 * `@experimental` decorator raises rather than warns, so adk-js throws.
 */
function assertFeatureEnabled(): void {
  if (!isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)) {
    throw new Error(
      `Feature ${FeatureName.ENVIRONMENT_SIMULATION} is not enabled.`,
    );
  }
}

/** Waits `seconds` before resolving. */
function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, seconds * MILLISECONDS_PER_SECOND),
  );
}

/**
 * Builds the strategy that mocks a tool response.
 *
 * @param mockStrategyType Which strategy the tool asked for.
 * @param modelName The model the strategy calls.
 * @param modelConfig The configuration of those model calls.
 * @returns A fresh strategy instance.
 * @throws {Error} When `mockStrategyType` names no strategy.
 */
export function createMockStrategy(
  mockStrategyType: MockStrategy,
  modelName: string,
  modelConfig: GenerateContentConfig,
): BaseMockStrategy {
  if (mockStrategyType === MockStrategy.MOCK_STRATEGY_TOOL_SPEC) {
    return new ToolSpecMockStrategy(modelName, modelConfig);
  }
  if (mockStrategyType === MockStrategy.MOCK_STRATEGY_TRACING) {
    return new TracingMockStrategy();
  }
  throw new Error(`Unknown mock strategy type: ${mockStrategyType}`);
}

/** Reports whether every entry of `matchArgs` is present and equal in `args`. */
function matchesArgs(
  matchArgs: Record<string, unknown>,
  args: Record<string, unknown>,
): boolean {
  return Object.entries(matchArgs).every(
    ([key, value]) => Object.hasOwn(args, key) && isEqual(args[key], value),
  );
}

/**
 * Answers a tool call from the configuration instead of running the tool.
 *
 * One engine serves one agent run: it analyzes the tool connections at most
 * once, and it keeps the state store that lets a mocked read see what a mocked
 * write produced.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export class EnvironmentSimulationEngine {
  private readonly toolSimConfigs: Map<string, ToolSimulationConfig>;
  private readonly analyzer: ToolConnectionAnalyzer;
  private readonly stateStore: Record<string, unknown> = {};
  private readonly random: SeededRandom = createSeededRandom();
  private isAnalyzed = false;
  private toolConnectionMap: ToolConnectionMap | undefined;

  /**
   * @param config The simulation to run, built with
   *     `createEnvironmentSimulationConfig`. The engine does not re-validate
   *     it.
   * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
   */
  constructor(private readonly config: EnvironmentSimulationConfig) {
    assertFeatureEnabled();
    this.toolSimConfigs = new Map(
      config.toolSimulationConfigs.map((c) => [c.toolName, c]),
    );
    this.analyzer = new ToolConnectionAnalyzer(
      config.simulationModel,
      config.simulationModelConfiguration,
    );
  }

  /**
   * Produces the response a simulated tool call returns.
   *
   * @param tool The tool the agent called.
   * @param args The arguments it called the tool with.
   * @param toolContext The context of the call.
   * @returns The simulated response, or `undefined` to run the real tool.
   */
  async simulate(
    tool: BaseTool,
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<Record<string, unknown> | undefined> {
    const toolSimConfig = this.toolSimConfigs.get(tool.name);
    if (!toolSimConfig) {
      return undefined;
    }

    await this.analyzeToolsOnce(toolContext);

    for (const injectionConfig of toolSimConfig.injectionConfigs) {
      if (
        injectionConfig.matchArgs &&
        !matchesArgs(injectionConfig.matchArgs, args)
      ) {
        continue;
      }
      if (injectionConfig.randomSeed !== undefined) {
        this.random.seed(injectionConfig.randomSeed);
      }
      if (this.random.next() >= injectionConfig.injectionProbability) {
        continue;
      }
      await sleepSeconds(injectionConfig.injectedLatencySeconds);
      if (injectionConfig.injectedError) {
        return {
          error_code: injectionConfig.injectedError.injectedHttpErrorCode,
          error_message: injectionConfig.injectedError.errorMessage,
        };
      }
      if (injectionConfig.injectedResponse) {
        return injectionConfig.injectedResponse;
      }
    }

    if (
      toolSimConfig.mockStrategyType === MockStrategy.MOCK_STRATEGY_UNSPECIFIED
    ) {
      logger.warn(
        `Tool '${tool.name}' did not hit any injection config and has no mock` +
          ' strategy configured. Returning no-op.',
      );
      return undefined;
    }

    const mockStrategy = createMockStrategy(
      toolSimConfig.mockStrategyType,
      this.config.simulationModel,
      this.config.simulationModelConfiguration,
    );
    return mockStrategy.mock({
      tool,
      args,
      toolConnectionMap: this.toolConnectionMap,
      stateStore: this.stateStore,
      environmentData: this.config.environmentData,
      tracing: this.config.tracing,
    });
  }

  /**
   * Analyzes the agent's tools the first time a mock strategy could need it.
   *
   * The engine marks the analysis done even when the agent is not an
   * `LlmAgent` and no analysis ran, so a non-LLM agent disables analysis for
   * the engine's lifetime rather than retrying on every call. adk-python does
   * the same.
   */
  private async analyzeToolsOnce(toolContext: Context): Promise<void> {
    if (this.isAnalyzed) {
      return;
    }
    const needsAnalysis = this.config.toolSimulationConfigs.some(
      (c) => c.mockStrategyType !== MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    );
    if (!needsAnalysis) {
      return;
    }
    const agent = toolContext.invocationContext.agent;
    if (isLlmAgent(agent)) {
      const tools = await agent.canonicalTools(toolContext);
      this.toolConnectionMap = await this.analyzer.analyze(tools);
    }
    this.isAnalyzed = true;
  }
}
