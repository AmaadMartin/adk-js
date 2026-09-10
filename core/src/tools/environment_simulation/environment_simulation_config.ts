/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';

/** The model the simulator uses for tool analysis and mock responses. */
const DEFAULT_SIMULATION_MODEL = 'gemini-2.5-flash';

/** The thinking budget the simulation model runs with by default. */
const DEFAULT_THINKING_BUDGET = 10240;

/** The largest latency an injection may add to a tool call. */
const MAX_INJECTED_LATENCY_SECONDS = 120;

/**
 * Mock strategy for a tool.
 *
 * @experimental Gated by {@link FeatureName.ENVIRONMENT_SIMULATION}.
 */
export enum MockStrategy {
  MOCK_STRATEGY_UNSPECIFIED = 'MOCK_STRATEGY_UNSPECIFIED',

  /** Use tool specifications to mock the tool response. */
  MOCK_STRATEGY_TOOL_SPEC = 'MOCK_STRATEGY_TOOL_SPEC',

  /**
   * @deprecated Use {@link MockStrategy.MOCK_STRATEGY_TOOL_SPEC} with tracing
   * input.
   */
  MOCK_STRATEGY_TRACING = 'MOCK_STRATEGY_TRACING',
}

/**
 * An error to be injected into a tool call.
 *
 * @experimental Gated by {@link FeatureName.ENVIRONMENT_SIMULATION}.
 */
export interface InjectedError {
  /**
   * Inject http error code to the tool call. Will present as "error_code" in
   * the tool response dict.
   */
  injectedHttpErrorCode: number;

  /**
   * Inject error message to the tool call. Will present as "error_message" in
   * the tool response dict.
   */
  errorMessage: string;
}

/**
 * Injection configuration for a tool.
 *
 * @experimental Gated by {@link FeatureName.ENVIRONMENT_SIMULATION}.
 */
export interface InjectionConfig {
  /** Probability of injecting the injected value. */
  injectionProbability: number;

  /**
   * Only apply injection if the request matches the match args. If match args
   * are not provided, the injection applies to all requests.
   */
  matchArgs?: Record<string, unknown>;

  /**
   * Inject latency to the tool call. It may not be accurate if the interceptor
   * runs as an after-tool callback.
   */
  injectedLatencySeconds: number;

  /** The random seed to use for this injection. */
  randomSeed?: number;

  /** The injected error. */
  injectedError?: InjectedError;

  /** The injected response. */
  injectedResponse?: Record<string, unknown>;
}

/** What a caller may pass to {@link createInjectionConfig}. */
export interface InjectionConfigParams {
  /** Defaults to `1`. */
  injectionProbability?: number;

  matchArgs?: Record<string, unknown>;

  /** Defaults to `0`, and may not exceed 120. */
  injectedLatencySeconds?: number;

  randomSeed?: number;

  injectedError?: InjectedError;

  injectedResponse?: Record<string, unknown>;
}

/**
 * Simulation configuration for a single tool.
 *
 * @experimental Gated by {@link FeatureName.ENVIRONMENT_SIMULATION}.
 */
export interface ToolSimulationConfig {
  /** Name of the tool to be simulated. */
  toolName: string;

  /**
   * Injection configuration for the tool. The tool is injected with the
   * injected value at the injection probability first, and the mock strategy
   * applies if no injection config is hit.
   */
  injectionConfigs: InjectionConfig[];

  /** The mock strategy to use. */
  mockStrategyType: MockStrategy;
}

/** What a caller may pass to {@link createToolSimulationConfig}. */
export interface ToolSimulationConfigParams {
  toolName: string;

  /** Defaults to an empty list. */
  injectionConfigs?: InjectionConfig[];

  /** Defaults to {@link MockStrategy.MOCK_STRATEGY_UNSPECIFIED}. */
  mockStrategyType?: MockStrategy;
}

/**
 * Configuration for an environment simulation.
 *
 * @experimental Gated by {@link FeatureName.ENVIRONMENT_SIMULATION}.
 */
export interface EnvironmentSimulationConfig {
  /** A list of tool simulation configurations. */
  toolSimulationConfigs: ToolSimulationConfig[];

  /**
   * The model to use for internal simulator LLM calls (tool analysis, mock
   * responses).
   */
  simulationModel: string;

  /** The configuration for the internal simulator LLM calls. */
  simulationModelConfiguration: GenerateContentConfig;

  /**
   * Tracing data (for example, a prior agent run trace as a JSON string) that
   * gives historical context for mock generation. Passed to mock strategies
   * alongside the environment data.
   */
  tracing?: string;

  /**
   * Environment-specific data (for example, a minimal database dump as a JSON
   * string). Passed to mock strategies for contextual mock generation.
   */
  environmentData?: string;
}

/** What a caller may pass to {@link createEnvironmentSimulationConfig}. */
export interface EnvironmentSimulationConfigParams {
  /**
   * Omit it and the config holds an empty list. Pass it and it must name at
   * least one tool, each tool once.
   */
  toolSimulationConfigs?: ToolSimulationConfig[];

  /** Defaults to `gemini-2.5-flash`. */
  simulationModel?: string;

  /** Defaults to a non-thinking configuration with a 10240 thinking budget. */
  simulationModelConfiguration?: GenerateContentConfig;

  tracing?: string;

  environmentData?: string;
}

/**
 * Mirrors Python's `bool(dict)`, where an empty dict is falsy. An empty
 * response injects nothing, so it counts as unset.
 */
function hasInjectedResponse(
  injectedResponse: Record<string, unknown> | undefined,
): boolean {
  return (
    injectedResponse !== undefined && Object.keys(injectedResponse).length > 0
  );
}

/** The first tool name that appears twice, or `undefined` if all are unique. */
function findDuplicateToolName(
  configs: ToolSimulationConfig[],
): string | undefined {
  const seen = new Set<string>();
  for (const config of configs) {
    if (seen.has(config.toolName)) {
      return config.toolName;
    }
    seen.add(config.toolName);
  }
  return undefined;
}

const injectedErrorSchema = z.strictObject({
  injectedHttpErrorCode: z.number().int(),
  errorMessage: z.string(),
});

const injectionConfigSchema = z
  .strictObject({
    injectionProbability: z.number(),
    matchArgs: z.record(z.string(), z.unknown()).optional(),
    injectedLatencySeconds: z.number().max(MAX_INJECTED_LATENCY_SECONDS),
    randomSeed: z.number().int().optional(),
    injectedError: injectedErrorSchema.optional(),
    injectedResponse: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (config) =>
      (config.injectedError !== undefined) !==
      hasInjectedResponse(config.injectedResponse),
    {
      message:
        'Either injectedError or injectedResponse must be set, but not both, and not neither.',
    },
  );

const toolSimulationConfigSchema = z
  .strictObject({
    toolName: z.string(),
    injectionConfigs: z.array(injectionConfigSchema),
    mockStrategyType: z.enum(MockStrategy),
  })
  .refine(
    (config) =>
      config.injectionConfigs.length > 0 ||
      config.mockStrategyType !== MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    {
      message:
        'If injectionConfigs is empty, mockStrategyType cannot be MOCK_STRATEGY_UNSPECIFIED.',
    },
  );

const toolSimulationConfigsSchema = z
  .array(toolSimulationConfigSchema)
  .superRefine((configs, ctx) => {
    if (configs.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'toolSimulationConfigs must be provided.',
      });
      return;
    }
    const duplicate = findDuplicateToolName(configs);
    if (duplicate !== undefined) {
      // `tool_name` names the repeated value, not a field, so it stays in the
      // reference wording.
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate tool_name found: ${duplicate}`,
      });
    }
  });

const environmentSimulationConfigSchema = z.strictObject({
  // Optional here so that omitting it skips the checks above, matching
  // pydantic, which never runs a field validator over a default.
  toolSimulationConfigs: toolSimulationConfigsSchema.optional(),
  simulationModel: z.string(),
  simulationModelConfiguration: z.custom<GenerateContentConfig>(
    (value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
    {message: 'Expected a GenerateContentConfig object'},
  ),
  tracing: z.string().optional(),
  environmentData: z.string().optional(),
});

/**
 * A fresh configuration per call, so two configs never share one object.
 */
function defaultSimulationModelConfiguration(): GenerateContentConfig {
  return {
    thinkingConfig: {
      includeThoughts: false,
      thinkingBudget: DEFAULT_THINKING_BUDGET,
    },
  };
}

function requireEnvironmentSimulationEnabled(): void {
  if (!isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)) {
    throw new Error(
      `Feature ${FeatureName.ENVIRONMENT_SIMULATION} is not enabled. ` +
        `Set ADK_ENABLE_${FeatureName.ENVIRONMENT_SIMULATION}=true to use it.`,
    );
  }
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  typeName: string,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid ${typeName}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Builds an {@link InjectedError}.
 *
 * @throws {InputValidationError} When a field has the wrong type, or an
 *   unknown field is present.
 * @throws {Error} When {@link FeatureName.ENVIRONMENT_SIMULATION} is disabled.
 */
export function createInjectedError(params: InjectedError): InjectedError {
  requireEnvironmentSimulationEnabled();
  return parseOrThrow(injectedErrorSchema, 'InjectedError', params);
}

/**
 * Builds an {@link InjectionConfig}, filling in the defaults.
 *
 * Exactly one of `injectedError` and `injectedResponse` must be set: an
 * injection that injects nothing has no effect, and a call cannot both fail
 * and return a response. An empty `injectedResponse` counts as unset.
 *
 * @throws {InputValidationError} When neither or both are set, when
 *   `injectedLatencySeconds` exceeds 120, or when a field has the wrong type.
 * @throws {Error} When {@link FeatureName.ENVIRONMENT_SIMULATION} is disabled.
 */
export function createInjectionConfig(
  params: InjectionConfigParams = {},
): InjectionConfig {
  requireEnvironmentSimulationEnabled();
  return parseOrThrow(injectionConfigSchema, 'InjectionConfig', {
    ...params,
    injectionProbability: params.injectionProbability ?? 1,
    injectedLatencySeconds: params.injectedLatencySeconds ?? 0,
  });
}

/**
 * Builds a {@link ToolSimulationConfig}, filling in the defaults.
 *
 * A tool with neither injections nor a mock strategy cannot be simulated, so
 * that combination is rejected.
 *
 * @throws {InputValidationError} When the tool has no injections and no mock
 *   strategy, or when a field has the wrong type.
 * @throws {Error} When {@link FeatureName.ENVIRONMENT_SIMULATION} is disabled.
 */
export function createToolSimulationConfig(
  params: ToolSimulationConfigParams,
): ToolSimulationConfig {
  requireEnvironmentSimulationEnabled();
  return parseOrThrow(toolSimulationConfigSchema, 'ToolSimulationConfig', {
    ...params,
    injectionConfigs: params.injectionConfigs ?? [],
    mockStrategyType:
      params.mockStrategyType ?? MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
  });
}

/**
 * Builds an {@link EnvironmentSimulationConfig}, filling in the defaults.
 *
 * Omitting `toolSimulationConfigs` yields an empty list, while passing an
 * empty list is an error. adk-python behaves the same way, because pydantic
 * runs a field validator over a supplied value but never over a default.
 *
 * @throws {InputValidationError} When `toolSimulationConfigs` is present and
 *   empty, when it names one tool twice, or when a field has the wrong type.
 * @throws {Error} When {@link FeatureName.ENVIRONMENT_SIMULATION} is disabled.
 */
export function createEnvironmentSimulationConfig(
  params: EnvironmentSimulationConfigParams = {},
): EnvironmentSimulationConfig {
  requireEnvironmentSimulationEnabled();
  const parsed = parseOrThrow(
    environmentSimulationConfigSchema,
    'EnvironmentSimulationConfig',
    {
      ...params,
      simulationModel: params.simulationModel ?? DEFAULT_SIMULATION_MODEL,
      simulationModelConfiguration:
        params.simulationModelConfiguration ??
        defaultSimulationModelConfiguration(),
    },
  );
  return {...parsed, toolSimulationConfigs: parsed.toolSimulationConfigs ?? []};
}
