/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {Context} from '../../agents/context.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';

import {
  EnvironmentSimulationConfig,
  InjectionConfig,
  MockStrategy,
  ToolSimulationConfig,
} from './environment_simulation_config.js';
import {
  BaseMockStrategy,
  SimulationStateStore,
  TracingMockStrategy,
} from './strategies/base.js';
import {ToolSpecMockStrategy} from './strategies/tool_spec_mock_strategy.js';
import {ToolConnectionAnalyzer} from './tool_connection_analyzer.js';
import {ToolConnectionMap} from './tool_connection_map.js';

/**
 * Draws the number an injection rule compares against its probability.
 *
 * adk-python seeds CPython's Mersenne Twister. JavaScript has no seedable
 * `Math.random`, so a seeded draw uses mulberry32 instead. The ported property
 * is that one seed makes the draw reproducible, not the value CPython returns
 * for it.
 */
type RandomGenerator = () => number;

/** Builds a generator that returns the same sequence for the same seed. */
function createSeededRandom(seed: number): RandomGenerator {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reports whether every entry of `matchArgs` appears in `args`.
 *
 * A call that carries extra arguments still matches, mirroring adk-python's
 * subset test over the argument entries.
 */
function matchesArgs(
  matchArgs: Record<string, unknown>,
  args: Record<string, unknown>,
): boolean {
  return Object.entries(matchArgs).every(
    ([key, value]) => key in args && Object.is(args[key], value),
  );
}

/** Waits `seconds` before the injected value is returned. */
function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Builds the strategy that mocks a tool the injection rules did not answer.
 *
 * `MOCK_STRATEGY_UNSPECIFIED` names no strategy. {@link
 * EnvironmentSimulationEngine.simulate} answers those calls itself, so that
 * value reaching here is a bug rather than a config a user can write.
 *
 * @param params.mockStrategyType Which strategy the tool config asked for.
 * @param params.model The model a strategy calls.
 * @param params.modelConfig The configuration of those model calls.
 * @returns The strategy to mock with.
 * @throws {InputValidationError} When `mockStrategyType` names no strategy.
 */
export function createMockStrategy(params: {
  mockStrategyType: MockStrategy;
  model: string;
  modelConfig: GenerateContentConfig;
}): BaseMockStrategy {
  switch (params.mockStrategyType) {
    case MockStrategy.MOCK_STRATEGY_TOOL_SPEC:
      return new ToolSpecMockStrategy({
        model: params.model,
        modelConfig: params.modelConfig,
      });
    case MockStrategy.MOCK_STRATEGY_TRACING:
      return new TracingMockStrategy();
    default:
      throw new InputValidationError(
        `Unknown mock strategy type: ${params.mockStrategyType}`,
      );
  }
}

/**
 * Answers tool calls out of a simulated environment.
 *
 * One engine holds the state a simulated run accumulates: whether the tools
 * have been analyzed, the entities the mock strategies created, and the
 * generator the injection rules draw from. Build it once and reuse it, or the
 * stateful mocking has nothing to be consistent with.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class EnvironmentSimulationEngine {
  private readonly config: EnvironmentSimulationConfig;
  private readonly toolSimConfigs: Map<string, ToolSimulationConfig>;
  private readonly analyzer: ToolConnectionAnalyzer;
  private readonly stateStore: SimulationStateStore = {};
  private isAnalyzed = false;
  private toolConnectionMap?: ToolConnectionMap;
  private randomGenerator: RandomGenerator = Math.random;

  /**
   * @param config The environment to simulate. Read, never mutated.
   */
  constructor(config: EnvironmentSimulationConfig) {
    this.config = config;
    this.toolSimConfigs = new Map(
      config.toolSimulationConfigs.map((toolConfig) => [
        toolConfig.toolName,
        toolConfig,
      ]),
    );
    this.analyzer = new ToolConnectionAnalyzer({
      model: config.simulationModel,
      modelConfig: config.simulationModelConfiguration,
    });
  }

  /**
   * Simulates one tool call.
   *
   * @param params.tool The tool the agent is about to call.
   * @param params.args The arguments it would be called with.
   * @param params.toolContext The context of the call.
   * @returns The response to return instead of calling the tool, or undefined
   *     to let the real tool run.
   */
  async simulate(params: {
    tool: BaseTool;
    args: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const toolSimConfig = this.toolSimConfigs.get(params.tool.name);
    if (!toolSimConfig) {
      return undefined;
    }

    await this.analyzeToolsOnce(params.toolContext);

    const injected = await this.applyInjectionConfigs(
      toolSimConfig.injectionConfigs,
      params.args,
    );
    if (injected) {
      return injected;
    }

    if (
      toolSimConfig.mockStrategyType === MockStrategy.MOCK_STRATEGY_UNSPECIFIED
    ) {
      logger.warn(
        `Tool '${params.tool.name}' did not hit any injection config and has` +
          ' no mock strategy configured. Returning no-op.',
      );
      return undefined;
    }

    const mockStrategy = createMockStrategy({
      mockStrategyType: toolSimConfig.mockStrategyType,
      model: this.config.simulationModel,
      modelConfig: this.config.simulationModelConfiguration,
    });
    return mockStrategy.mock({
      tool: params.tool,
      args: params.args,
      toolContext: params.toolContext,
      toolConnectionMap: this.toolConnectionMap,
      stateStore: this.stateStore,
      environmentData: this.config.environmentData,
      tracing: this.config.tracing,
    });
  }

  /**
   * Runs the tool connection analysis at most once per engine.
   *
   * The analysis only pays for itself once some tool is mocked by a strategy,
   * so a configuration that just injects responses never calls a model. An
   * agent that is not an `LlmAgent` has no tools to analyze, and the engine
   * does not retry it.
   */
  private async analyzeToolsOnce(toolContext: Context): Promise<void> {
    if (this.isAnalyzed || !this.hasMockStrategy()) {
      return;
    }
    const agent = toolContext.invocationContext.agent;
    if (isLlmAgent(agent)) {
      const tools = await agent.canonicalTools(toolContext);
      this.toolConnectionMap = await this.analyzer.analyze(tools);
    }
    this.isAnalyzed = true;
  }

  /** Reports whether any configured tool asks for a mock strategy. */
  private hasMockStrategy(): boolean {
    return this.config.toolSimulationConfigs.some(
      (toolConfig) =>
        toolConfig.mockStrategyType !== MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    );
  }

  /**
   * Returns the value of the first injection rule that fires.
   *
   * Rules are tried in declaration order. The first rule that both matches the
   * arguments and wins its probability draw answers the call, and no later
   * rule runs.
   */
  private async applyInjectionConfigs(
    injectionConfigs: InjectionConfig[],
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    for (const injectionConfig of injectionConfigs) {
      if (
        injectionConfig.matchArgs &&
        !matchesArgs(injectionConfig.matchArgs, args)
      ) {
        continue;
      }

      if (injectionConfig.randomSeed !== undefined) {
        this.randomGenerator = createSeededRandom(injectionConfig.randomSeed);
      }

      if (this.randomGenerator() >= injectionConfig.injectionProbability) {
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
    return undefined;
  }
}
