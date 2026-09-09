/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isEqual} from 'lodash-es';

import {Context} from '../../agents/context.js';
import {isLlmAgent, SingleBeforeToolCallback} from '../../agents/llm_agent.js';
import {sleep} from '../../utils/async_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {seededRandom} from '../../utils/random_utils.js';
import {BaseTool} from '../base_tool.js';

import {
  EnvironmentSimulationConfig,
  MockStrategyType,
  ResolvedEnvironmentSimulationConfig,
  ResolvedToolSimulationConfig,
  resolveEnvironmentSimulationConfig,
} from './environment_simulation_config.js';
import {ToolConnectionAnalyzer} from './tool_connection_analyzer.js';
import {ToolConnectionMap} from './tool_connection_map.js';
import {StateStore, ToolSpecMockStrategy} from './tool_spec_mock_strategy.js';

const MILLISECONDS_PER_SECOND = 1000;

/** The deprecated tracing strategy is a placeholder, in adk-python too. */
const TRACING_NOT_IMPLEMENTED = {
  status: 'error',
  error_message: 'Not implemented',
};

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
  private readonly mockStrategy: ToolSpecMockStrategy;
  private readonly usesMockStrategy: boolean;
  private readonly stateStore: StateStore = {};
  private analysis?: Promise<void>;
  private toolConnectionMap?: ToolConnectionMap;

  /**
   * @param config The environment to simulate.
   * @throws If a tool has nothing to simulate with, if it names a strategy
   *     that does not exist, if a tool name repeats, if an injection rule does
   *     not set exactly one of `injectedError` and `injectedResponse`, or if
   *     an injected latency exceeds the cap.
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
    this.mockStrategy = new ToolSpecMockStrategy(
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

    if (
      toolSimulationConfig.mockStrategyType ===
      MockStrategyType.MOCK_STRATEGY_TRACING
    ) {
      return {...TRACING_NOT_IMPLEMENTED};
    }

    return this.mockStrategy.mock({
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
      const draw =
        injectionConfig.randomSeed === undefined
          ? Math.random()
          : seededRandom(injectionConfig.randomSeed);
      if (draw >= injectionConfig.injectionProbability) {
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

/**
 * Builds a callback for a single agent's `beforeToolCallback`.
 *
 * @param config The environment to simulate.
 * @return A callback that answers the configured tools from the simulation.
 * @throws If the config is invalid, on the same terms as the
 *     {@link EnvironmentSimulationEngine} constructor.
 * @experimental
 */
export function createEnvironmentSimulationCallback(
  config: EnvironmentSimulationConfig,
): SingleBeforeToolCallback {
  const engine = new EnvironmentSimulationEngine(config);
  return ({tool, args, context}) => engine.simulate(tool, args, context);
}
