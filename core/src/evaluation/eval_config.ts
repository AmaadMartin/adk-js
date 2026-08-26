/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import {z} from 'zod';

import {CodeConfigSchema} from '../agents/common_configs.js';
import {logger} from '../utils/logger.js';
import {toCamelCase, toSnakeCaseKey} from '../utils/object_notation_utils.js';
import {DEFAULT_LIVE_TIMEOUT_SECONDS} from './constants.js';
import {
  BaseCriterion,
  BaseCriterionSchema,
  EvalMetric,
  MetricInfoSchema,
} from './eval_metrics.js';

/**
 * Configuration for a custom metric.
 */
export const CustomMetricConfigSchema = z.object({
  /** Code config used to locate the custom metric function. */
  codeConfig: CodeConfigSchema,
  /** Metric info for the custom metric. */
  metricInfo: MetricInfoSchema.optional(),
  /** Description for the custom metric info. */
  description: z.string().default(''),
});

/**
 * Configuration for a custom metric.
 */
export type CustomMetricConfig = z.infer<typeof CustomMetricConfigSchema>;

/**
 * Configuration for evaluating models in live (bidirectional streaming) mode.
 */
export const LiveModelConfigSchema = z.object({
  /** Timeout in seconds for waiting for model turn completion in live mode. */
  timeoutSeconds: z.number().default(DEFAULT_LIVE_TIMEOUT_SECONDS),
});

/**
 * Configuration for evaluating models in live (bidirectional streaming) mode.
 */
export type LiveModelConfig = z.infer<typeof LiveModelConfigSchema>;

/**
 * Configurations needed to run an Eval.
 *
 * Allows users to specify metrics, their thresholds and other properties.
 */
export const EvalConfigSchema = z.object({
  /**
   * A dictionary that maps a metric name to the criterion to use for it. The
   * value is either a plain numeric threshold or a richer criterion object
   * (e.g. an LLM-as-a-judge criterion).
   */
  criteria: z
    .record(z.string(), z.union([z.number(), BaseCriterionSchema]))
    .default(() => ({})),
  /**
   * A dictionary mapping custom metric names to their configuration. If a
   * metric name in `criteria` is also present here, its `codeConfig` is used to
   * locate the custom metric implementation.
   */
  customMetrics: z.record(z.string(), CustomMetricConfigSchema).optional(),
  /**
   * Config to be used by the user simulator. Typed as an opaque passthrough
   * for now; the concrete discriminated union (selected via a `type` field) is
   * ported in a later sub-port that delivers `evaluation/simulation/`.
   */
  userSimulatorConfig: z.unknown().optional(),
  /**
   * Config for evaluating in live (bidirectional streaming) mode. Required for
   * Live API models (e.g. `gemini-*-live-*`).
   */
  liveModelConfig: LiveModelConfigSchema.optional(),
});

/**
 * Configurations needed to run an Eval.
 */
export type EvalConfig = z.infer<typeof EvalConfigSchema>;

/**
 * Default criteria used when no eval config file is supplied.
 */
const DEFAULT_EVAL_CONFIG: EvalConfig = EvalConfigSchema.parse({
  criteria: {
    tool_trajectory_avg_score: 1.0,
    response_match_score: 0.8,
  },
});

/** Config fields whose keys are metric names chosen by the user. */
const METRIC_KEYED_FIELDS = ['criteria', 'customMetrics'] as const;

/** The paths those fields are reached by, in either spelling. */
const METRIC_KEYED_PATHS = METRIC_KEYED_FIELDS.flatMap((field) => [
  field,
  toSnakeCaseKey(field),
]);

/**
 * Rewrites an eval config's own field names to camelCase, so a config file
 * written by adk-python loads here. A criterion spells its match type
 * `match_type` there and `matchType` here, and the whole criterion is dropped
 * silently without this step.
 *
 * The keys of `criteria` and `customMetrics` are metric names, so they are
 * left exactly as written; only the values under them are rewritten.
 */
function toCamelCaseEvalConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }

  const config = toCamelCase(raw, METRIC_KEYED_PATHS) as Record<
    string,
    unknown
  >;
  for (const field of METRIC_KEYED_FIELDS) {
    const metricMap = config[field];
    if (typeof metricMap !== 'object' || metricMap === null) {
      continue;
    }
    config[field] = Object.fromEntries(
      Object.entries(metricMap).map(([metricName, value]) => [
        metricName,
        toCamelCase(value),
      ]),
    );
  }
  return config;
}

/**
 * Returns the `EvalConfig` read from the config file, if present. Otherwise a
 * default one is returned.
 *
 * A missing, empty, or nonexistent path is not an error: the default config is
 * returned. A present-but-malformed file throws (via `JSON.parse` or schema
 * validation).
 *
 * @param evalConfigFilePath Path to a JSON eval config file.
 */
export function getEvaluationCriteriaOrDefault(
  evalConfigFilePath?: string,
): EvalConfig {
  if (evalConfigFilePath && fs.existsSync(evalConfigFilePath)) {
    const content = fs.readFileSync(evalConfigFilePath, 'utf-8');
    return EvalConfigSchema.parse(
      toCamelCaseEvalConfig(JSON.parse(content) as unknown),
    );
  }

  logger.info(
    'No config file supplied or file not found. Using default criteria.',
  );
  return DEFAULT_EVAL_CONFIG;
}

/**
 * An {@link EvalMetric} whose criterion, and therefore whose threshold, is
 * known to be present. Every metric derived from an `EvalConfig` is one.
 */
export type CriterionBackedEvalMetric = EvalMetric & {criterion: BaseCriterion};

/**
 * Flattens an `EvalConfig`'s criteria into the list of `EvalMetric`s that an
 * eval run consumes, preserving criteria insertion order.
 */
export function getEvalMetricsFromConfig(
  evalConfig: EvalConfig,
): CriterionBackedEvalMetric[] {
  const evalMetricList: CriterionBackedEvalMetric[] = [];
  for (const [metricName, criterion] of Object.entries(evalConfig.criteria)) {
    const customFunctionPath =
      evalConfig.customMetrics?.[metricName]?.codeConfig.name;

    const resolvedCriterion: BaseCriterion =
      typeof criterion === 'number'
        ? BaseCriterionSchema.parse({threshold: criterion})
        : criterion;

    evalMetricList.push({
      metricName,
      threshold: resolvedCriterion.threshold,
      criterion: resolvedCriterion,
      customFunctionPath,
    });
  }
  return evalMetricList;
}
