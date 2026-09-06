/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import {logger} from '../utils/logger.js';
import {DEFAULT_LIVE_TIMEOUT_SECONDS} from './constants.js';
import {isRecord, toCamelKeys} from './eval_json.js';
import {BaseCriterion, EvalMetric, PrebuiltMetrics} from './eval_metrics.js';

/**
 * How a metric is judged: a bare threshold, or a criterion object for metrics
 * that need more than one setting.
 */
export type Criterion = number | BaseCriterion;

/** Locates the scoring function of a custom metric. */
export interface CustomMetricCodeConfig {
  /** Module specifier of the scoring function. */
  name: string;
}

/** Declares a metric that is scored by user-supplied code. */
export interface CustomMetricConfig {
  codeConfig: CustomMetricCodeConfig;

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

/** Everything needed to run an eval, as read from a `test_config.json`. */
export interface EvalConfig {
  /** Metric name to the criterion that metric is judged against. */
  criteria: Record<string, Criterion>;

  /** Metric name to the code that scores it. */
  customMetrics?: Record<string, CustomMetricConfig>;

  /**
   * Settings for the user simulator. The simulator subsystem owns this shape
   * and reads it; this package forwards it unchanged.
   */
  userSimulatorConfig?: Record<string, unknown>;

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
 */
export function parseEvalConfig(raw: unknown): EvalConfig {
  if (!isRecord(raw)) {
    throw new Error('An eval config must be a JSON object.');
  }
  return {
    criteria: mapValuesToCamelCase(raw['criteria']),
    customMetrics: parseCustomMetrics(raw['custom_metrics']),
    userSimulatorConfig: parseNestedRecord(raw['user_simulator_config']),
    liveModelConfig: parseLiveModelConfig(raw['live_model_config']),
  };
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
    const converted = toCamelKeys(config);
    if (!isRecord(converted) || !isRecord(converted['codeConfig'])) {
      throw new Error(
        `Custom metric '${metricName}' must have a \`code_config\`.`,
      );
    }
    const name = converted['codeConfig']['name'];
    if (typeof name !== 'string') {
      throw new Error(
        `Custom metric '${metricName}' must have a \`code_config.name\`.`,
      );
    }
    customMetrics[metricName] = {
      codeConfig: {name},
      description:
        typeof converted['description'] === 'string'
          ? converted['description']
          : undefined,
    };
  }
  return customMetrics;
}

function parseNestedRecord(raw: unknown): Record<string, unknown> | undefined {
  const converted = toCamelKeys(raw);
  return isRecord(converted) ? converted : undefined;
}

function parseLiveModelConfig(raw: unknown): LiveModelConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const timeoutSeconds = raw['timeout_seconds'];
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

/** Maps the criteria of an eval config to the metrics an eval run scores. */
export function getEvalMetricsFromConfig(evalConfig: EvalConfig): EvalMetric[] {
  return Object.entries(evalConfig.criteria).map(([metricName, criterion]) => {
    const customFunctionPath =
      evalConfig.customMetrics?.[metricName]?.codeConfig.name;
    const resolved: BaseCriterion =
      typeof criterion === 'number' ? {threshold: criterion} : criterion;
    return {
      metricName,
      threshold: resolved.threshold,
      criterion: resolved,
      customFunctionPath,
    };
  });
}
