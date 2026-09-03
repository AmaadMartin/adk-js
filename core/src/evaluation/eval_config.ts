/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {z} from 'zod';
import {codeConfigSchema, type CodeConfig} from '../agents/common_configs.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {logger} from '../utils/logger.js';
import {isRecord, toCamelCase} from '../utils/object_notation_utils.js';
import {evalModel, optionalField, type EvalModel} from './common.js';
import {DEFAULT_LIVE_TIMEOUT_SECONDS} from './constants.js';
import {
  parseMetricInfo,
  PrebuiltMetrics,
  setConfigCustomFunctionPath,
  type BaseCriterion,
  type EvalMetric,
  type MetricInfo,
} from './eval_metrics.js';
import {
  LLM_AUDIO_USER_SIMULATOR_TYPE,
  llmAudioUserSimulatorConfigModel,
  type LlmAudioUserSimulatorConfig,
} from './simulation/llm_audio_user_simulator.js';
import {
  LLM_BACKED_USER_SIMULATOR_TYPE,
  llmBackedUserSimulatorConfigModel,
  type LlmBackedUserSimulatorConfig,
} from './simulation/llm_backed_user_simulator.js';

/**
 * How a metric is judged: a bare threshold, or a criterion object for metrics
 * that need more than one setting.
 */
export type Criterion = number | BaseCriterion;

/** Declares a metric that is scored by user-supplied code. */
export interface CustomMetricConfig {
  codeConfig: CodeConfig;

  /**
   * What the metric measures and the range it reports. Absent unless the
   * config declares it.
   */
  metricInfo?: MetricInfo;

  description?: string;
}

/** Settings for evaluating a model in live (bidirectional streaming) mode. */
export interface LiveModelConfig {
  /**
   * Seconds to wait for a model turn to complete. Defaults to
   * {@link DEFAULT_LIVE_TIMEOUT_SECONDS} when a config file omits it.
   */
  timeoutSeconds: number;
}

/** The user simulator configs an eval config can select between. */
export type UserSimulatorConfig =
  | LlmBackedUserSimulatorConfig
  | LlmAudioUserSimulatorConfig;

/** Everything needed to run an eval, as read from a `test_config.json`. */
export interface EvalConfig {
  /** Metric name to the criterion that metric is judged against. */
  criteria: Record<string, Criterion>;

  /** Metric name to the code that scores it. */
  customMetrics?: Record<string, CustomMetricConfig>;

  /** Which user simulator drives the conversation, and how. */
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
 * The `type` an eval config written before the discriminator existed is read
 * as. See {@link injectDefaultUserSimulatorType}.
 */
const LEGACY_DEFAULT_USER_SIMULATOR_TYPE = LLM_BACKED_USER_SIMULATOR_TYPE;

/** Both spellings of the user simulator section, as adk-python accepts. */
const USER_SIMULATOR_CONFIG_KEYS = [
  'user_simulator_config',
  'userSimulatorConfig',
] as const;

/**
 * Validates the user simulator section against the config its `type` names.
 *
 * @throws {InputValidationError} When `type` names no known simulator, or the
 *   section does not fit the config that `type` names.
 */
function parseUserSimulatorConfig(raw: unknown): UserSimulatorConfig {
  const type = isRecord(raw) ? raw['type'] : undefined;
  if (type === LLM_BACKED_USER_SIMULATOR_TYPE) {
    return llmBackedUserSimulatorConfigModel.parse(raw);
  }
  if (type === LLM_AUDIO_USER_SIMULATOR_TYPE) {
    return llmAudioUserSimulatorConfigModel.parse(raw);
  }
  throw new InputValidationError(
    `An eval config names a user simulator of type ${JSON.stringify(type)}. ` +
      `The supported types are '${LLM_BACKED_USER_SIMULATOR_TYPE}' and ` +
      `'${LLM_AUDIO_USER_SIMULATOR_TYPE}'.`,
  );
}

/**
 * Reads a criterion, converting the keys inside it to camelCase.
 *
 * The metric name that keys the criterion is chosen by whoever wrote the
 * config, so it is left exactly as written.
 */
const criterionSchema = z.unknown().transform((raw, ctx): Criterion => {
  if (typeof raw === 'number') {
    return raw;
  }
  const converted = toCamelCase(raw);
  const threshold = isRecord(converted) ? converted['threshold'] : undefined;
  if (!isRecord(converted) || typeof threshold !== 'number') {
    ctx.addIssue({
      code: 'custom',
      message:
        'a criterion must be a threshold or an object with a `threshold`',
    });
    return z.NEVER;
  }
  return {...converted, threshold};
});

/** Validates a {@link CustomMetricConfig} payload. */
const customMetricConfigModel: EvalModel<CustomMetricConfig> = evalModel(
  {
    codeConfig: codeConfigSchema,
    metricInfo: optionalField(
      z.custom<MetricInfo>().transform(parseMetricInfo),
    ),
    description: optionalField(z.string()),
  },
  {name: 'CustomMetricConfig', extraKeys: 'allow'},
);

/** Validates a {@link LiveModelConfig} payload. */
const liveModelConfigModel: EvalModel<LiveModelConfig> = evalModel(
  {timeoutSeconds: z.number().int().default(DEFAULT_LIVE_TIMEOUT_SECONDS)},
  {name: 'LiveModelConfig', extraKeys: 'allow'},
);

/**
 * Validates an {@link EvalConfig} payload.
 *
 * adk-python generates a camelCase alias for every field of these models and
 * populates by name as well, so both spellings load. {@link evalModel} applies
 * the same rule. An unrecognized key is kept where pydantic drops it, which
 * never rejects a document adk-python accepts.
 */
const evalConfigModel: EvalModel<EvalConfig> = evalModel(
  {
    criteria: z.record(z.string(), criterionSchema).prefault({}),
    customMetrics: optionalField(
      z.record(z.string(), customMetricConfigModel.schema),
    ),
    userSimulatorConfig: optionalField(
      z.custom<UserSimulatorConfig>().transform(parseUserSimulatorConfig),
    ),
    liveModelConfig: optionalField(liveModelConfigModel.schema),
  },
  {name: 'EvalConfig', extraKeys: 'allow'},
);

/**
 * Names the legacy simulator in a section written before `type` existed.
 *
 * An explicit `null` counts as absent, because that is what serializing a
 * config whose `type` was never set produces. A section that names a `type` is
 * left untouched.
 */
function injectDefaultUserSimulatorType(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  let values = raw;
  for (const key of USER_SIMULATOR_CONFIG_KEYS) {
    const section = values[key];
    if (!isRecord(section) || (section['type'] ?? undefined) !== undefined) {
      continue;
    }
    logger.info(
      `eval_config.${key} has no \`type\` discriminator; defaulting to ` +
        `'${LEGACY_DEFAULT_USER_SIMULATOR_TYPE}'. Add ` +
        `"type": "${LEGACY_DEFAULT_USER_SIMULATOR_TYPE}" to your config to ` +
        'make this explicit.',
    );
    values = {
      ...values,
      [key]: {...section, type: LEGACY_DEFAULT_USER_SIMULATOR_TYPE},
    };
  }
  return values;
}

/**
 * Converts a JSON value to an {@link EvalConfig}.
 *
 * The keys of the `criteria` and `customMetrics` maps are metric names, so
 * they are left exactly as written; every other key loads in either casing.
 *
 * @throws {InputValidationError} When the value is not an object, or a section
 *   of it does not fit the model.
 */
export function parseEvalConfig(raw: unknown): EvalConfig {
  if (!isRecord(raw)) {
    throw new InputValidationError('An eval config must be a JSON object.');
  }
  return evalConfigModel.parse(injectDefaultUserSimulatorType(raw));
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

/** Names the type of a value that is not a criterion, for an error message. */
function describeCriterionType(criterion: unknown): string {
  if (criterion === null) {
    return 'null';
  }
  if (Array.isArray(criterion)) {
    return 'array';
  }
  return typeof criterion;
}

/**
 * Reads the criterion a metric is judged against.
 *
 * @throws {InputValidationError} When the criterion is neither a threshold nor
 *   an object carrying one. {@link parseEvalConfig} rejects that on the read
 *   path; this covers a config built in code.
 */
function resolveCriterion(
  metricName: string,
  criterion: Criterion,
): BaseCriterion {
  if (typeof criterion === 'number') {
    return {threshold: criterion};
  }
  if (isRecord(criterion) && typeof criterion.threshold === 'number') {
    return criterion;
  }
  throw new InputValidationError(
    `Unexpected criterion type for metric '${metricName}'. ` +
      `${describeCriterionType(criterion)} not supported.`,
  );
}

/**
 * Maps the criteria of an eval config to the metrics an eval run scores.
 *
 * A metric a `customMetrics` entry names also carries that entry's function
 * path off-object, which is where the metric evaluator registry reads it from.
 *
 * @throws {InputValidationError} When a criterion is neither a threshold nor
 *   an object carrying one.
 */
export function getEvalMetricsFromConfig(evalConfig: EvalConfig): EvalMetric[] {
  return Object.entries(evalConfig.criteria).map(([metricName, criterion]) => {
    const customFunctionPath =
      evalConfig.customMetrics?.[metricName]?.codeConfig.name;
    const resolved = resolveCriterion(metricName, criterion);
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
