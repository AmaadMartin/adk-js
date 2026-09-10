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

/** The model the simulator calls when the caller names none. */
const DEFAULT_SIMULATION_MODEL = 'gemini-2.5-flash';

/** The thinking budget the simulator's own model calls get by default. */
const DEFAULT_THINKING_BUDGET = 10240;

/** An injection fires on every call unless a probability says otherwise. */
const DEFAULT_INJECTION_PROBABILITY = 1;

/** The longest latency an injection may add to a tool call. */
const MAX_INJECTED_LATENCY_SECONDS = 120;

/**
 * An error returned in place of a tool call.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface InjectedError {
  /** Surfaces to the model as `error_code` in the tool response. */
  injectedHttpErrorCode: number;

  /** Surfaces to the model as `error_message` in the tool response. */
  errorMessage: string;
}

/**
 * One injection rule for a tool, with every default filled in.
 *
 * Exactly one of `injectedError` and `injectedResponse` carries a value.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface InjectionConfig {
  /**
   * How often the rule fires. Defaults to 1, so the rule fires on every
   * call. adk-python declares no bounds on this field, so neither does
   * adk-js.
   */
  injectionProbability: number;

  /**
   * Restricts the rule to calls whose arguments contain these entries. When
   * absent, the rule applies to every call of the tool.
   */
  matchArgs?: Record<string, unknown>;

  /**
   * Latency added before the injected value is returned, in seconds. Defaults
   * to 0 and may not exceed 120. It may be inexact when the interceptor runs
   * as an after-tool callback.
   */
  injectedLatencySeconds: number;

  /** Seeds the generator that draws against `injectionProbability`. */
  randomSeed?: number;

  /** The error to return instead of calling the tool. */
  injectedError?: InjectedError;

  /** The response body to return instead of calling the tool. */
  injectedResponse?: Record<string, unknown>;
}

/**
 * How a tool response is mocked once no injection rule has fired.
 *
 * adk-python numbers these members; adk-js gives them string values, which is
 * what every other adk-js enum does. The values never cross a wire, and the
 * member names are what a config document and an error message show.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export enum MockStrategy {
  MOCK_STRATEGY_UNSPECIFIED = 'MOCK_STRATEGY_UNSPECIFIED',

  /** Ask a model to mock the response from the tool's own declaration. */
  MOCK_STRATEGY_TOOL_SPEC = 'MOCK_STRATEGY_TOOL_SPEC',

  /** @deprecated Use `MOCK_STRATEGY_TOOL_SPEC` with tracing input. */
  MOCK_STRATEGY_TRACING = 'MOCK_STRATEGY_TRACING',
}

/**
 * How one tool is simulated, with every default filled in.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface ToolSimulationConfig {
  /** The name of the tool to simulate. */
  toolName: string;

  /**
   * Injection rules for the tool, applied before the mock strategy. Defaults
   * to an empty list.
   */
  injectionConfigs: InjectionConfig[];

  /**
   * Mocks the response when no injection rule fires. Defaults to
   * {@link MockStrategy.MOCK_STRATEGY_UNSPECIFIED}.
   */
  mockStrategyType: MockStrategy;
}

/**
 * The fields {@link createToolSimulationConfig} accepts.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface ToolSimulationConfigParams {
  /** The name of the tool to simulate. */
  toolName: string;

  /** Injection rules for the tool. */
  injectionConfigs?: Array<Partial<InjectionConfig>>;

  /** Mocks the response when no injection rule fires. */
  mockStrategyType?: MockStrategy;
}

/**
 * The configuration of a simulated environment, with every default filled in.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface EnvironmentSimulationConfig {
  /** The tools to simulate. Each tool name appears at most once. */
  toolSimulationConfigs: ToolSimulationConfig[];

  /**
   * The model the simulator calls to analyze tools and mock responses.
   * Defaults to `gemini-2.5-flash`.
   */
  simulationModel: string;

  /** The configuration of those model calls. */
  simulationModelConfiguration: GenerateContentConfig;

  /**
   * A prior agent run trace, as a JSON string, used as context when a mock
   * strategy generates a response.
   */
  tracing?: string;

  /**
   * Environment-specific data, such as a small database dump, as a JSON
   * string. Passed to the mock strategies alongside `tracing`.
   */
  environmentData?: string;
}

/**
 * The fields {@link createEnvironmentSimulationConfig} accepts.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface EnvironmentSimulationConfigParams {
  /** The tools to simulate. */
  toolSimulationConfigs?: ToolSimulationConfigParams[];

  /** The model the simulator calls to analyze tools and mock responses. */
  simulationModel?: string;

  /** The configuration of those model calls. */
  simulationModelConfiguration?: GenerateContentConfig;

  /** A prior agent run trace, as a JSON string. */
  tracing?: string;

  /** Environment-specific data, as a JSON string. */
  environmentData?: string;
}

/**
 * Reports whether the rule injects an error or a response, but not both.
 *
 * adk-python compares `bool(injected_error) == bool(injected_response)`, and
 * an empty dict is falsy in Python. An empty `injectedResponse` object
 * therefore counts as unset on both sides.
 */
function hasExactlyOneInjectedValue(config: {
  injectedError?: InjectedError;
  injectedResponse?: Record<string, unknown>;
}): boolean {
  const hasError = config.injectedError !== undefined;
  const hasResponse =
    config.injectedResponse !== undefined &&
    Object.keys(config.injectedResponse).length > 0;
  return hasError !== hasResponse;
}

/** Reports whether the tool has any way to produce a simulated response. */
function isSimulatable(config: {
  injectionConfigs: InjectionConfig[];
  mockStrategyType: MockStrategy;
}): boolean {
  return (
    config.injectionConfigs.length > 0 ||
    config.mockStrategyType !== MockStrategy.MOCK_STRATEGY_UNSPECIFIED
  );
}

// The schemas below stay module-private: the interfaces and the factories are
// the public surface.
//
// `strictObject` rejects an unknown key. That is deliberately stricter than
// adk-python, whose models are plain `BaseModel` and therefore drop an unknown
// key in silence. A factory that also receives parsed JSON is the wrong place
// to swallow a misspelled field.

const injectedErrorSchema = z.strictObject({
  injectedHttpErrorCode: z.int(),
  errorMessage: z.string(),
});

const injectionConfigSchema = z
  .strictObject({
    injectionProbability: z.number().default(DEFAULT_INJECTION_PROBABILITY),
    matchArgs: z.record(z.string(), z.unknown()).optional(),
    injectedLatencySeconds: z
      .number()
      .max(MAX_INJECTED_LATENCY_SECONDS)
      .default(0),
    randomSeed: z.int().optional(),
    injectedError: injectedErrorSchema.optional(),
    injectedResponse: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(hasExactlyOneInjectedValue, {
    error:
      'Either injectedError or injectedResponse must be set, but not both,' +
      ' and not neither.',
  });

const toolSimulationConfigSchema = z
  .strictObject({
    toolName: z.string(),
    injectionConfigs: z.array(injectionConfigSchema).default(() => []),
    mockStrategyType: z
      .enum(MockStrategy)
      .default(MockStrategy.MOCK_STRATEGY_UNSPECIFIED),
  })
  .refine(isSimulatable, {
    error:
      'If injectionConfigs is empty, mockStrategyType cannot be' +
      ' MOCK_STRATEGY_UNSPECIFIED.',
  });

// Only the object-ness of the model configuration is checked, so the genai SDK
// stays the single source of truth for its field list.
const generateContentConfigSchema = z.custom<GenerateContentConfig>(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  {error: 'Expected an object.'},
);

const environmentSimulationConfigSchema = z.strictObject({
  toolSimulationConfigs: z.array(toolSimulationConfigSchema).default(() => []),
  simulationModel: z.string().default(DEFAULT_SIMULATION_MODEL),
  simulationModelConfiguration: generateContentConfigSchema.default(() => ({
    thinkingConfig: {
      includeThoughts: false,
      thinkingBudget: DEFAULT_THINKING_BUDGET,
    },
  })),
  tracing: z.string().optional(),
  environmentData: z.string().optional(),
});

function assertFeatureEnabled(): void {
  if (!isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)) {
    throw new Error(
      `Feature ${FeatureName.ENVIRONMENT_SIMULATION} is not enabled.`,
    );
  }
}

function parseOrThrow<S extends z.ZodType>(
  schema: S,
  typeName: string,
  params: unknown,
): z.infer<S> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid ${typeName}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Rejects a tool list that simulates nothing, or names one tool twice.
 *
 * The duplicate message keeps adk-python's `tool_name` spelling, because it
 * names the repeated value rather than the adk-js field.
 */
function assertToolSimulationConfigsUsable(
  configs: ToolSimulationConfig[],
): void {
  if (configs.length === 0) {
    throw new InputValidationError(
      'Invalid EnvironmentSimulationConfig: toolSimulationConfigs must be' +
        ' provided.',
    );
  }
  const seenToolNames = new Set<string>();
  for (const config of configs) {
    if (seenToolNames.has(config.toolName)) {
      throw new InputValidationError(
        `Invalid EnvironmentSimulationConfig: Duplicate tool_name found:` +
          ` ${config.toolName}`,
      );
    }
    seenToolNames.add(config.toolName);
  }
}

/**
 * Creates an {@link InjectedError}.
 *
 * @param params The HTTP error code and message to inject.
 * @returns A validated, freshly built {@link InjectedError}.
 * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
 * @throws {InputValidationError} When `params` carries an unknown key, or a
 *     field has the wrong type.
 */
export function createInjectedError(params: InjectedError): InjectedError {
  assertFeatureEnabled();
  return parseOrThrow(injectedErrorSchema, 'InjectedError', params);
}

/**
 * Creates an {@link InjectionConfig} with the defaults adk-python applies.
 *
 * @param params Optional {@link InjectionConfig} fields. The object is read,
 *     never mutated.
 * @returns A validated, freshly built {@link InjectionConfig}.
 * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
 * @throws {InputValidationError} When neither or both of `injectedError` and
 *     `injectedResponse` are set, when `injectedLatencySeconds` exceeds 120,
 *     or when `params` carries an unknown key.
 */
export function createInjectionConfig(
  params: Partial<InjectionConfig> = {},
): InjectionConfig {
  assertFeatureEnabled();
  return parseOrThrow(injectionConfigSchema, 'InjectionConfig', params);
}

/**
 * Creates a {@link ToolSimulationConfig} with the defaults adk-python applies.
 *
 * @param params The tool name, and optionally its injection rules and mock
 *     strategy. The object is read, never mutated.
 * @returns A validated, freshly built {@link ToolSimulationConfig}.
 * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
 * @throws {InputValidationError} When the tool has neither an injection rule
 *     nor a mock strategy, when a nested injection rule is invalid, or when
 *     `params` carries an unknown key.
 */
export function createToolSimulationConfig(
  params: ToolSimulationConfigParams,
): ToolSimulationConfig {
  assertFeatureEnabled();
  return parseOrThrow(
    toolSimulationConfigSchema,
    'ToolSimulationConfig',
    params,
  );
}

/**
 * Creates an {@link EnvironmentSimulationConfig} with the defaults adk-python
 * applies.
 *
 * Omitting `toolSimulationConfigs` is not the same as passing an empty list.
 * adk-python checks emptiness in a pydantic field validator, and pydantic does
 * not validate a default, so an omitted field yields an empty list while an
 * explicitly empty list is an error. adk-js reproduces that.
 *
 * @param params Optional configuration fields. The object is read, never
 *     mutated.
 * @returns A validated, freshly built {@link EnvironmentSimulationConfig}.
 * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
 * @throws {InputValidationError} When `toolSimulationConfigs` is explicitly
 *     empty, when two tool configs name the same tool, when a nested config is
 *     invalid, or when `params` carries an unknown key.
 */
export function createEnvironmentSimulationConfig(
  params: EnvironmentSimulationConfigParams = {},
): EnvironmentSimulationConfig {
  assertFeatureEnabled();
  const config = parseOrThrow(
    environmentSimulationConfigSchema,
    'EnvironmentSimulationConfig',
    params,
  );
  if (params.toolSimulationConfigs !== undefined) {
    assertToolSimulationConfigsUsable(config.toolSimulationConfigs);
  }
  return config;
}
