/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

/** The model used for the simulator's own calls when none is configured. */
const DEFAULT_SIMULATION_MODEL = 'gemini-2.5-flash';

/** The thinking budget used for the simulator's own calls. */
const DEFAULT_THINKING_BUDGET = 10240;

/** An injection fires on every call unless a probability says otherwise. */
const DEFAULT_INJECTION_PROBABILITY = 1.0;

/** The longest latency an injection may add to a tool call. */
const MAX_INJECTED_LATENCY_SECONDS = 120;

/**
 * How a tool response is mocked once no injection rule has fired.
 *
 * @experimental
 */
export enum MockStrategyType {
  MOCK_STRATEGY_UNSPECIFIED = 'MOCK_STRATEGY_UNSPECIFIED',
  /** Ask a model to mock the response from the tool's own declaration. */
  MOCK_STRATEGY_TOOL_SPEC = 'MOCK_STRATEGY_TOOL_SPEC',
  /** @deprecated Use `MOCK_STRATEGY_TOOL_SPEC` with tracing input. */
  MOCK_STRATEGY_TRACING = 'MOCK_STRATEGY_TRACING',
}

/**
 * An error returned in place of a tool call.
 *
 * @experimental
 */
export interface InjectedError {
  /** Surfaces to the model as `error_code` in the tool response. */
  injectedHttpErrorCode: number;
  /** Surfaces to the model as `error_message` in the tool response. */
  errorMessage: string;
}

/**
 * One injection rule for a tool.
 *
 * Exactly one of `injectedError` and `injectedResponse` must be set.
 *
 * @experimental
 */
export interface InjectionConfig {
  /** How often the rule fires, in `[0, 1]`. Defaults to 1. */
  injectionProbability?: number;
  /** Restricts the rule to calls whose arguments contain these entries. */
  matchArgs?: Record<string, unknown>;
  /** Latency added before the injected value is returned. Defaults to 0. */
  injectedLatencySeconds?: number;
  /** Seeds the generator that draws against `injectionProbability`. */
  randomSeed?: number;
  /** The error to return. */
  injectedError?: InjectedError;
  /** The response body to return. */
  injectedResponse?: Record<string, unknown>;
}

/**
 * How one tool is simulated.
 *
 * The tool needs at least one injection rule or a mock strategy, otherwise it
 * would have nothing to simulate with.
 *
 * @experimental
 */
export interface ToolSimulationConfig {
  /** The name of the tool to simulate. */
  toolName: string;
  /** Injection rules, evaluated in order. The first rule that fires wins. */
  injectionConfigs?: InjectionConfig[];
  /** Mocks the response when no injection rule fires. */
  mockStrategyType?: MockStrategyType;
}

/**
 * The configuration of a whole simulated environment.
 *
 * @experimental
 */
export interface EnvironmentSimulationConfig {
  /** The tools to simulate. Must be non-empty, and each name must be unique. */
  toolSimulationConfigs: ToolSimulationConfig[];
  /** The model the simulator calls to analyze tools and mock responses. */
  simulationModel?: string;
  /** The configuration of those calls. */
  simulationModelConfiguration?: GenerateContentConfig;
  /** A prior agent run trace, as JSON, used as context for mocking. */
  tracing?: string;
  /** Environment data, such as a small database dump, as JSON. */
  environmentData?: string;
}

/**
 * An {@link InjectionConfig} with every default filled in.
 *
 * @experimental
 */
export interface ResolvedInjectionConfig extends InjectionConfig {
  injectionProbability: number;
  injectedLatencySeconds: number;
}

/**
 * A {@link ToolSimulationConfig} with every default filled in.
 *
 * @experimental
 */
export interface ResolvedToolSimulationConfig extends ToolSimulationConfig {
  injectionConfigs: ResolvedInjectionConfig[];
  mockStrategyType: MockStrategyType;
}

/**
 * An {@link EnvironmentSimulationConfig} with every default filled in.
 *
 * @experimental
 */
export interface ResolvedEnvironmentSimulationConfig extends EnvironmentSimulationConfig {
  toolSimulationConfigs: ResolvedToolSimulationConfig[];
  simulationModel: string;
  simulationModelConfiguration: GenerateContentConfig;
}

function resolveInjectionConfig(
  config: InjectionConfig,
): ResolvedInjectionConfig {
  if (!config.injectedError === !config.injectedResponse) {
    throw new Error(
      'Either injectedError or injectedResponse must be set, but not both,' +
        ' and not neither.',
    );
  }
  const injectedLatencySeconds = config.injectedLatencySeconds ?? 0;
  if (injectedLatencySeconds > MAX_INJECTED_LATENCY_SECONDS) {
    throw new Error(
      `injectedLatencySeconds must be at most ${MAX_INJECTED_LATENCY_SECONDS}.`,
    );
  }
  return {
    ...config,
    injectionProbability:
      config.injectionProbability ?? DEFAULT_INJECTION_PROBABILITY,
    injectedLatencySeconds,
  };
}

const MOCK_STRATEGY_TYPES = new Set<string>(Object.values(MockStrategyType));

function resolveToolSimulationConfig(
  config: ToolSimulationConfig,
): ResolvedToolSimulationConfig {
  const injectionConfigs = (config.injectionConfigs ?? []).map(
    resolveInjectionConfig,
  );
  const mockStrategyType =
    config.mockStrategyType ?? MockStrategyType.MOCK_STRATEGY_UNSPECIFIED;
  if (!MOCK_STRATEGY_TYPES.has(mockStrategyType)) {
    throw new Error(`Unknown mock strategy type: ${mockStrategyType}`);
  }
  if (
    injectionConfigs.length === 0 &&
    mockStrategyType === MockStrategyType.MOCK_STRATEGY_UNSPECIFIED
  ) {
    throw new Error(
      'If injectionConfigs is empty, mockStrategyType cannot be' +
        ' MOCK_STRATEGY_UNSPECIFIED.',
    );
  }
  return {...config, injectionConfigs, mockStrategyType};
}

/**
 * Validates a simulation config and fills in every default.
 *
 * @param config The config supplied by the caller.
 * @return The same config with every optional field resolved.
 * @throws If a tool has nothing to simulate with, if it names a strategy that
 *     does not exist, if a tool name repeats, if an injection rule does not
 *     set exactly one of `injectedError` and `injectedResponse`, or if an
 *     injected latency exceeds the cap.
 * @experimental
 */
export function resolveEnvironmentSimulationConfig(
  config: EnvironmentSimulationConfig,
): ResolvedEnvironmentSimulationConfig {
  const toolSimulationConfigs = config.toolSimulationConfigs.map(
    resolveToolSimulationConfig,
  );
  if (toolSimulationConfigs.length === 0) {
    throw new Error('toolSimulationConfigs must be provided.');
  }
  const seenToolNames = new Set<string>();
  for (const toolSimulationConfig of toolSimulationConfigs) {
    if (seenToolNames.has(toolSimulationConfig.toolName)) {
      throw new Error(
        `Duplicate toolName found: ${toolSimulationConfig.toolName}`,
      );
    }
    seenToolNames.add(toolSimulationConfig.toolName);
  }
  return {
    ...config,
    toolSimulationConfigs,
    simulationModel: config.simulationModel ?? DEFAULT_SIMULATION_MODEL,
    simulationModelConfiguration: config.simulationModelConfiguration ?? {
      thinkingConfig: {
        includeThoughts: false,
        thinkingBudget: DEFAULT_THINKING_BUDGET,
      },
    },
  };
}
