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
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {createSeededRandom} from '../../utils/random_utils.js';
import {BaseTool} from '../base_tool.js';

import {
  EnvironmentSimulationConfig,
  EnvironmentSimulationConfigInput,
  EnvironmentSimulationConfigSchema,
  MockStrategy,
  ToolSimulationConfig,
} from './environment_simulation_config.js';
import {BaseMockStrategy, TracingMockStrategy} from './strategies/base.js';
import {ToolSpecMockStrategy} from './strategies/tool_spec_mock_strategy.js';
import {ToolConnectionAnalyzer} from './tool_connection_analyzer.js';
import {ToolConnectionMap} from './tool_connection_map.js';

/** The request to simulate a single tool call. */
export interface SimulateRequest {
  /** The tool the model asked to call. */
  tool: BaseTool;
  /** The arguments the model called it with. */
  args: Record<string, unknown>;
  /** The context of the tool call. */
  toolContext: Context;
}

/**
 * Creates the mock strategy for a configured strategy type.
 *
 * @param mockStrategyType The configured strategy type.
 * @param llmName The model the strategy generates mock responses with.
 * @param llmConfig The generation config for that model.
 * @returns The strategy instance.
 * @throws If the strategy type has no implementation.
 */
export function createMockStrategy(
  mockStrategyType: MockStrategy,
  llmName: string,
  llmConfig: GenerateContentConfig,
): BaseMockStrategy {
  switch (mockStrategyType) {
    case MockStrategy.MOCK_STRATEGY_TOOL_SPEC:
      return new ToolSpecMockStrategy(llmName, llmConfig);
    case MockStrategy.MOCK_STRATEGY_TRACING:
      return new TracingMockStrategy();
    default:
      throw new Error(`Unknown mock strategy type: ${mockStrategyType}`);
  }
}

/**
 * Whether every entry of `matchArgs` is present in `args` with a structurally
 * equal value.
 *
 * Only own keys of `args` count, matching Python's `item in args.items()`. An
 * `in` test would walk the prototype chain and report `__proto__` or
 * `constructor` as present in every argument object.
 */
function matchesArgs(
  matchArgs: Record<string, unknown>,
  args: Record<string, unknown>,
): boolean {
  return Object.entries(matchArgs).every(
    ([key, value]) => Object.hasOwn(args, key) && isEqual(args[key], value),
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Simulates the responses of configured tools so an agent can be exercised
 * end-to-end without those tools ever running.
 *
 * The engine keeps a state store of the entities its mock strategies invent,
 * which is what makes a later `get_x` call consistent with an earlier
 * `create_x`. That store is scoped to the engine instance, has no eviction,
 * and therefore grows for the engine's lifetime; create a new engine per
 * simulation run rather than sharing one across unrelated sessions.
 */
@experimental
export class EnvironmentSimulationEngine {
  private readonly config: EnvironmentSimulationConfig;
  private readonly toolSimConfigs: Map<string, ToolSimulationConfig>;
  private readonly analyzer: ToolConnectionAnalyzer;
  private readonly stateStore: Record<string, Record<string, unknown>> = {};
  private toolConnectionMap?: ToolConnectionMap;
  private isAnalyzed = false;
  private nextRandom: () => number = () => Math.random();

  /**
   * @param config The simulation configuration. Validated here, so an invalid
   *     configuration throws a `ZodError` at construction.
   * @throws If the `ENVIRONMENT_SIMULATION` feature is disabled.
   */
  constructor(config: EnvironmentSimulationConfigInput) {
    if (!isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)) {
      throw new Error(
        `Feature ${FeatureName.ENVIRONMENT_SIMULATION} is not enabled.`,
      );
    }
    this.config = EnvironmentSimulationConfigSchema.parse(config);
    this.toolSimConfigs = new Map(
      this.config.toolSimulationConfigs.map((config) => [
        config.toolName,
        config,
      ]),
    );
    this.analyzer = new ToolConnectionAnalyzer(
      this.config.simulationModel,
      this.config.simulationModelConfiguration,
    );
  }

  /**
   * Simulates a tool call.
   *
   * @param request The tool, its arguments and the tool call context.
   * @returns The simulated response, or `undefined` when the tool should run
   *     for real — either because it is not configured, or because none of its
   *     injections fired and it has no mock strategy.
   */
  async simulate({
    tool,
    args,
    toolContext,
  }: SimulateRequest): Promise<Record<string, unknown> | undefined> {
    const toolSimConfig = this.toolSimConfigs.get(tool.name);
    if (!toolSimConfig) {
      return undefined;
    }

    await this.analyzeToolConnectionsOnce(toolContext);

    for (const injectionConfig of toolSimConfig.injectionConfigs) {
      if (
        injectionConfig.matchArgs &&
        !matchesArgs(injectionConfig.matchArgs, args)
      ) {
        continue;
      }
      if (injectionConfig.randomSeed !== undefined) {
        this.nextRandom = createSeededRandom(injectionConfig.randomSeed);
      }
      if (this.nextRandom() < injectionConfig.injectionProbability) {
        await sleep(injectionConfig.injectedLatencySeconds * 1000);
        const {injectedError} = injectionConfig;
        return injectedError
          ? {
              error_code: injectedError.injectedHttpErrorCode,
              error_message: injectedError.errorMessage,
            }
          : injectionConfig.injectedResponse;
      }
    }

    if (
      toolSimConfig.mockStrategyType === MockStrategy.MOCK_STRATEGY_UNSPECIFIED
    ) {
      logger.warn(
        `Tool '${tool.name}' did not hit any injection config and has no` +
          ' mock strategy configured. Returning no-op.',
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
      toolContext,
      toolConnectionMap: this.toolConnectionMap,
      stateStore: this.stateStore,
      environmentData: this.config.environmentData,
      tracing: this.config.tracing,
    });
  }

  /**
   * Analyzes the calling agent's tools the first time a mock strategy could
   * need the result. The analysis costs an LLM call, so it runs at most once
   * per engine and is skipped entirely when no tool has a mock strategy.
   */
  private async analyzeToolConnectionsOnce(
    toolContext: Context,
  ): Promise<void> {
    const anyToolHasStrategy = this.config.toolSimulationConfigs.some(
      (config) =>
        config.mockStrategyType !== MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    );
    if (this.isAnalyzed || !anyToolHasStrategy) {
      return;
    }
    const agent = toolContext.invocationContext.agent;
    if (isLlmAgent(agent)) {
      this.toolConnectionMap = await this.analyzer.analyze(
        await agent.canonicalTools(toolContext),
      );
    }
    this.isAnalyzed = true;
  }
}
