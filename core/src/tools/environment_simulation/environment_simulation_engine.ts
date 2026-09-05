/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {isEqual} from 'lodash-es';

import {Context} from '../../agents/context.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {SeededRandomGenerator} from '../../utils/random_utils.js';
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

/** Milliseconds in a second; the config states latency in seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Builds the strategy that mocks a tool response once no injection rule fired.
 *
 * `MOCK_STRATEGY_UNSPECIFIED` means the tool has no strategy at all, so it is
 * rejected here rather than mapped to a do-nothing strategy. The engine returns
 * before reaching this for such a tool.
 *
 * @param mockStrategyType The strategy the tool's config asks for.
 * @param model The model the strategy calls.
 * @param modelConfig The configuration of that model call.
 * @returns The strategy to mock the response with.
 * @throws {InputValidationError} When `mockStrategyType` names no strategy.
 */
export function createMockStrategy(
  mockStrategyType: MockStrategy,
  model: string,
  modelConfig: GenerateContentConfig,
): BaseMockStrategy {
  if (mockStrategyType === MockStrategy.MOCK_STRATEGY_TOOL_SPEC) {
    return new ToolSpecMockStrategy({model, modelConfig});
  }
  if (mockStrategyType === MockStrategy.MOCK_STRATEGY_TRACING) {
    return new TracingMockStrategy();
  }
  throw new InputValidationError(
    `Unknown mock strategy type: ${mockStrategyType}`,
  );
}

/**
 * Reports whether every entry of `matchArgs` appears in `args`.
 *
 * adk-python compares entries, not whole objects, so a rule that names one
 * argument still fires on a call that passes several. Values are compared
 * structurally, so an object-valued rule is reachable. Only own arguments
 * count, so a rule naming an inherited property such as `constructor` does not
 * match every call.
 *
 * @param args The arguments the agent passed to the tool.
 * @param matchArgs The entries the rule requires.
 * @returns True when the rule applies to this call.
 */
function matchesArgs(
  args: Record<string, unknown>,
  matchArgs: Record<string, unknown>,
): boolean {
  return Object.entries(matchArgs).every(
    ([key, value]) => Object.hasOwn(args, key) && isEqual(args[key], value),
  );
}

/** Waits `seconds` before the injected value is returned. */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, seconds * MILLISECONDS_PER_SECOND),
  );
}

/**
 * The value an injection rule returns in place of the tool's own response.
 *
 * adk-python spells the error keys `error_code` and `error_message`. adk-js
 * spells every key it produces itself in camelCase, following the config
 * module.
 *
 * An empty `injectedResponse` returns nothing, so the engine tries the next
 * rule. An empty dict is falsy in Python, and the config module already counts
 * an empty response as unset for the same reason.
 */
function injectedValue(
  injectionConfig: InjectionConfig,
): Record<string, unknown> | undefined {
  if (injectionConfig.injectedError) {
    return {
      errorCode: injectionConfig.injectedError.injectedHttpErrorCode,
      errorMessage: injectionConfig.injectedError.errorMessage,
    };
  }
  const {injectedResponse} = injectionConfig;
  if (injectedResponse && Object.keys(injectedResponse).length > 0) {
    return injectedResponse;
  }
  return undefined;
}

/**
 * Answers a tool call from a simulated environment instead of calling the tool.
 *
 * One engine holds the state of one simulation: whether the tools have been
 * analyzed, the entities the mock strategies created, and the generator the
 * injection rules draw against. Build it once and share it across every call,
 * which is what {@link EnvironmentSimulationFactory} does.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class EnvironmentSimulationEngine {
  private readonly config: EnvironmentSimulationConfig;
  private readonly toolSimulationConfigs: Map<string, ToolSimulationConfig>;
  private readonly analyzer: ToolConnectionAnalyzer;
  private readonly stateStore: SimulationStateStore = {};
  private readonly randomGenerator = new SeededRandomGenerator();
  private isAnalyzed = false;
  private toolConnectionMap?: ToolConnectionMap;

  /**
   * @param config The simulation to run. Build it with
   *     `createEnvironmentSimulationConfig`, which applies the defaults and
   *     rejects a configuration that simulates nothing.
   */
  constructor(config: EnvironmentSimulationConfig) {
    this.config = config;
    this.toolSimulationConfigs = new Map(
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
   * @param params.tool The tool the agent asked to call.
   * @param params.args The arguments the agent passed.
   * @param params.context The context of the tool call.
   * @returns The simulated response, or `undefined` to let the real tool run.
   */
  async simulate(params: {
    tool: BaseTool;
    args: Record<string, unknown>;
    context: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const toolConfig = this.toolSimulationConfigs.get(params.tool.name);
    if (!toolConfig) {
      return undefined;
    }

    await this.analyzeToolsOnce(params.context);

    for (const injectionConfig of toolConfig.injectionConfigs) {
      if (
        injectionConfig.matchArgs &&
        !matchesArgs(params.args, injectionConfig.matchArgs)
      ) {
        continue;
      }
      if (injectionConfig.randomSeed !== undefined) {
        this.randomGenerator.seed(injectionConfig.randomSeed);
      }
      if (this.randomGenerator.next() < injectionConfig.injectionProbability) {
        await sleep(injectionConfig.injectedLatencySeconds);
        const value = injectedValue(injectionConfig);
        if (value) {
          return value;
        }
      }
    }

    if (
      toolConfig.mockStrategyType === MockStrategy.MOCK_STRATEGY_UNSPECIFIED
    ) {
      logger.warn(
        `Tool '${params.tool.name}' did not hit any injection config and has` +
          ' no mock strategy configured. Returning no-op.',
      );
      return undefined;
    }

    const mockStrategy = createMockStrategy(
      toolConfig.mockStrategyType,
      this.config.simulationModel,
      this.config.simulationModelConfiguration,
    );
    return mockStrategy.mock({
      tool: params.tool,
      args: params.args,
      context: params.context,
      toolConnectionMap: this.toolConnectionMap,
      stateStore: this.stateStore,
      environmentData: this.config.environmentData,
      tracing: this.config.tracing,
    });
  }

  /**
   * Analyzes how the simulated tools connect, at most once per engine and only
   * when some tool has a mock strategy that could use the result.
   *
   * An agent that is not an LLM agent has no tool list to analyze. The engine
   * still marks the analysis done, so it is not retried on every later call.
   *
   * @param context The context of the tool call that triggered the analysis.
   */
  private async analyzeToolsOnce(context: Context): Promise<void> {
    if (this.isAnalyzed || !this.hasAnyMockStrategy()) {
      return;
    }
    const agent = context.invocationContext.agent;
    if (isLlmAgent(agent)) {
      const tools = await agent.canonicalTools(context);
      this.toolConnectionMap = await this.analyzer.analyze(tools);
    }
    this.isAnalyzed = true;
  }

  /** Reports whether any simulated tool asks for a mock strategy. */
  private hasAnyMockStrategy(): boolean {
    return this.config.toolSimulationConfigs.some(
      (toolConfig) =>
        toolConfig.mockStrategyType !== MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    );
  }
}
