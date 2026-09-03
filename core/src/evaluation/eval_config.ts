/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {z} from 'zod';
import {CodeConfig, codeConfigSchema} from '../agents/common_configs.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {logger} from '../utils/logger.js';
import {isRecord, toCamelCase} from '../utils/object_notation_utils.js';
import {DEFAULT_LIVE_TIMEOUT_SECONDS} from './constants.js';
import {
  BaseCriterion,
  EvalMetric,
  MetricInfo,
  parseMetricInfo,
  PrebuiltMetrics,
  setConfigCustomFunctionPath,
} from './eval_metrics.js';
import {
  LLM_AUDIO_USER_SIMULATOR_TYPE,
  LlmAudioUserSimulatorConfig,
  parseLlmAudioUserSimulatorConfig,
} from './simulation/llm_audio_user_simulator.js';
import {
  LLM_BACKED_USER_SIMULATOR_TYPE,
  LlmBackedUserSimulatorConfig,
  parseLlmBackedUserSimulatorConfig,
} from './simulation/llm_backed_user_simulator.js';

/**
 * How a metric is judged: a bare threshold, or a criterion object for metrics
 * that need more than one setting.
 */
export type Criterion = number | BaseCriterion;

/**
 * Locates the scoring function of a custom metric. An alias of the shared
 * {@link CodeConfig}, which adk-python's `CustomMetricConfig` also names.
 */
export type CustomMetricCodeConfig = CodeConfig;

/** Declares a metric that is scored by user-supplied code. */
export interface CustomMetricConfig {
  codeConfig: CodeConfig;

  /**
   * What the eval framework knows about the metric: the range it reports
   * values in, and a description of what it measures.
   */
  metricInfo?: MetricInfo;

  description?: string;
}

/** The user-simulator settings an eval config carries, named by their `type`. */
export type UserSimulatorConfig =
  | LlmBackedUserSimulatorConfig
  | LlmAudioUserSimulatorConfig;

/** Settings for evaluating a model in live (bidirectional streaming) mode. */
export interface LiveModelConfig {
  /**
   * Seconds to wait for a model turn to complete. Defaults to
   * {@link DEFAULT_LIVE_TIMEOUT_SECONDS} when a config file omits it.
   */
  timeoutSeconds: number;
}

/** Everything needed to run an eval, as read from a `test_config.json`. */
export interface EvalConfig {
  /** Metric name to the criterion that metric is judged against. */
  criteria: Record<string, Criterion>;

  /** Metric name to the code that scores it. */
  customMetrics?: Record<string, CustomMetricConfig>;

  /**
   * Settings for the user simulator. Its `type` names the simulator that
   * reads it; a config written before `type` existed reads as
   * {@link LlmBackedUserSimulatorConfig}.
   */
  userSimulatorConfig?: UserSimulatorConfig;

  liveModelConfig?: LiveModelConfig;
}

/** The criteria applied when a test folder has no `test_config.json`. */
export const DEFAULT_EVAL_CONFIG: EvalConfig = {
  criteria: {
    [PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE]: 1.0,
    [PrebuiltMetrics.RESPONSE_MATCH_SCORE]: 0.8,
  },
};

/**
 * Converts a JSON value to an {@link EvalConfig}.
 *
 * The keys of the `criteria` and `custom_metrics` maps are metric names, so
 * they are left exactly as written; every other key is converted to camelCase.
 * A field is read by either spelling, so a config written by adk-python and a
 * config written by this package both load.
 */
export function parseEvalConfig(raw: unknown): EvalConfig {
  if (!isRecord(raw)) {
    throw new Error('An eval config must be a JSON object.');
  }
  return {
    criteria: mapValuesToCamelCase(raw['criteria']),
    customMetrics: parseCustomMetrics(
      readField(raw, 'customMetrics', 'custom_metrics'),
    ),
    userSimulatorConfig: parseUserSimulatorConfig(
      readField(raw, 'userSimulatorConfig', 'user_simulator_config'),
    ),
    liveModelConfig: parseLiveModelConfig(
      readField(raw, 'liveModelConfig', 'live_model_config'),
    ),
  };
}

/**
 * Reads a field by its canonical camelCase key, falling back to the snake_case
 * spelling adk-python writes. The canonical spelling wins when a document
 * carries both, which is what adk-python's `populate_by_name` does.
 */
function readField(
  raw: Record<string, unknown>,
  key: string,
  alias: string,
): unknown {
  return key in raw ? raw[key] : raw[alias];
}

/**
 * Keys whose values are opaque user data, such as the arguments a tool was
 * called with. Their contents keep the exact keys they were written with.
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  'args',
  'response',
  'state',
  'final_session_state',
  'finalSessionState',
]);

/** Rewrites snake_case keys to camelCase, leaving opaque values untouched. */
function toCamelKeys(value: unknown): unknown {
  return toCamelCase(value, [], OPAQUE_KEYS);
}

/** Converts each value of a map, leaving the map's own keys untouched. */
function mapValuesToCamelCase(raw: unknown): Record<string, Criterion> {
  if (!isRecord(raw)) {
    return {};
  }
  const criteria: Record<string, Criterion> = {};
  for (const [metricName, criterion] of Object.entries(raw)) {
    if (typeof criterion === 'number') {
      criteria[metricName] = criterion;
      continue;
    }
    const converted = toCamelKeys(criterion);
    const threshold = isRecord(converted) ? converted['threshold'] : undefined;
    if (!isRecord(converted) || typeof threshold !== 'number') {
      throw new Error(
        `Unexpected criterion for metric '${metricName}'. A criterion must ` +
          'be a threshold or an object with a `threshold`.',
      );
    }
    criteria[metricName] = {...converted, threshold};
  }
  return criteria;
}

function parseCustomMetrics(
  raw: unknown,
): Record<string, CustomMetricConfig> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const customMetrics: Record<string, CustomMetricConfig> = {};
  for (const [metricName, config] of Object.entries(raw)) {
    customMetrics[metricName] = parseCustomMetric(metricName, config);
  }
  return customMetrics;
}

function parseCustomMetric(
  metricName: string,
  raw: unknown,
): CustomMetricConfig {
  const converted = toCamelKeys(raw);
  if (!isRecord(converted) || !isRecord(converted['codeConfig'])) {
    throw new Error(
      `Custom metric '${metricName}' must have a \`code_config\`.`,
    );
  }
  if (typeof converted['codeConfig']['name'] !== 'string') {
    throw new Error(
      `Custom metric '${metricName}' must have a \`code_config.name\`.`,
    );
  }
  const metricInfo = converted['metricInfo'];
  return {
    codeConfig: parseCodeConfig(metricName, converted['codeConfig']),
    metricInfo:
      metricInfo === undefined || metricInfo === null
        ? undefined
        : parseMetricInfo(metricInfo),
    description:
      typeof converted['description'] === 'string'
        ? converted['description']
        : undefined,
  };
}

/**
 * Validates the code reference of a custom metric against the shared
 * {@link codeConfigSchema}, so it holds the same contract wherever adk-js
 * reads a code reference: a non-empty `name`, and no key besides it.
 */
function parseCodeConfig(metricName: string, raw: unknown): CodeConfig {
  const result = codeConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new InputValidationError(
      `Custom metric '${metricName}' has an invalid \`code_config\`: ` +
        z.prettifyError(result.error),
      {cause: result.error},
    );
  }
  return result.data;
}

/**
 * The `type` given to a user-simulator config that carries none, so that a
 * config written before the discriminator existed still loads.
 */
const LEGACY_DEFAULT_USER_SIMULATOR_TYPE = LLM_BACKED_USER_SIMULATOR_TYPE;

/** The user-simulator config each `type` selects. */
const USER_SIMULATOR_PARSERS = new Map<
  string,
  (raw: unknown) => UserSimulatorConfig
>([
  [LLM_BACKED_USER_SIMULATOR_TYPE, parseLlmBackedUserSimulatorConfig],
  [LLM_AUDIO_USER_SIMULATOR_TYPE, parseLlmAudioUserSimulatorConfig],
]);

/**
 * Validates the user-simulator section of an eval config, selecting the
 * config its `type` names.
 *
 * @throws {InputValidationError} When the section is not an object, or names
 *   a `type` no simulator answers to.
 */
function parseUserSimulatorConfig(
  raw: unknown,
): UserSimulatorConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const converted = toCamelKeys(raw);
  if (!isRecord(converted)) {
    throw new InputValidationError(
      'The `userSimulatorConfig` of an eval config must be a JSON object.',
    );
  }
  const type = converted['type'] ?? defaultUserSimulatorType();
  const parse =
    typeof type === 'string' ? USER_SIMULATOR_PARSERS.get(type) : undefined;
  if (!parse) {
    throw new InputValidationError(
      `The \`userSimulatorConfig\` of an eval config names an unknown ` +
        `\`type\` ${JSON.stringify(type)}. Accepted values: ` +
        `${[...USER_SIMULATOR_PARSERS.keys()].join(', ')}.`,
    );
  }
  return parse({...converted, type});
}

/** Reports that a config carries no `type`, and names the one it gets. */
function defaultUserSimulatorType(): string {
  logger.debug(
    '`userSimulatorConfig` has no `type`; reading it as ' +
      `'${LEGACY_DEFAULT_USER_SIMULATOR_TYPE}'. Add ` +
      `"type": "${LEGACY_DEFAULT_USER_SIMULATOR_TYPE}" to the eval config to ` +
      'make this explicit.',
  );
  return LEGACY_DEFAULT_USER_SIMULATOR_TYPE;
}

function parseLiveModelConfig(raw: unknown): LiveModelConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const timeoutSeconds = readField(raw, 'timeoutSeconds', 'timeout_seconds');
  return {
    timeoutSeconds:
      typeof timeoutSeconds === 'number'
        ? timeoutSeconds
        : DEFAULT_LIVE_TIMEOUT_SECONDS,
  };
}

/**
 * Reads an eval config from the given path, or returns
 * {@link DEFAULT_EVAL_CONFIG} when no path was supplied or the file is absent.
 */
export async function getEvaluationCriteriaOrDefault(
  evalConfigFilePath?: string,
): Promise<EvalConfig> {
  if (evalConfigFilePath) {
    const content = await readFileIfPresent(evalConfigFilePath);
    if (content !== undefined) {
      return parseEvalConfig(JSON.parse(content));
    }
  }
  logger.debug('No config file supplied or file not found. Using defaults.');
  return DEFAULT_EVAL_CONFIG;
}

/** Returns the file's contents, or undefined when it does not exist. */
async function readFileIfPresent(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isFileNotFoundError(err)) {
      return undefined;
    }
    throw err;
  }
}

function isFileNotFoundError(err: unknown): boolean {
  return isRecord(err) && err['code'] === 'ENOENT';
}

/**
 * Maps the criteria of an eval config to the metrics an eval run scores.
 *
 * The path a config declares for a custom metric travels with the metric, so
 * two apps in one process can name the same metric and each still reaches its
 * own scoring function. Read it back with `getConfigCustomFunctionPath`.
 */
export function getEvalMetricsFromConfig(evalConfig: EvalConfig): EvalMetric[] {
  return Object.entries(evalConfig.criteria).map(([metricName, criterion]) => {
    const customFunctionPath =
      evalConfig.customMetrics?.[metricName]?.codeConfig.name;
    const resolved: BaseCriterion =
      typeof criterion === 'number' ? {threshold: criterion} : criterion;
    const evalMetric: EvalMetric = {
      metricName,
      threshold: resolved.threshold,
      criterion: resolved,
      customFunctionPath,
    };
    if (customFunctionPath !== undefined) {
      setConfigCustomFunctionPath(evalMetric, customFunctionPath);
    }
    return evalMetric;
  });
}
