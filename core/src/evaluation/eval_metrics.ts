/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * Metrics that ADK ships with.
 *
 * The string values are written into eval config files and eval results, so
 * they match adk-python exactly.
 */
export enum PrebuiltMetrics {
  TOOL_TRAJECTORY_AVG_SCORE = 'tool_trajectory_avg_score',
  RESPONSE_EVALUATION_SCORE = 'response_evaluation_score',
  RESPONSE_MATCH_SCORE = 'response_match_score',
  SAFETY_V1 = 'safety_v1',
  FINAL_RESPONSE_MATCH_V2 = 'final_response_match_v2',
  RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1 = 'rubric_based_final_response_quality_v1',
  HALLUCINATIONS_V1 = 'hallucinations_v1',
  RUBRIC_BASED_TOOL_USE_QUALITY_V1 = 'rubric_based_tool_use_quality_v1',
  PER_TURN_USER_SIMULATOR_QUALITY_V1 = 'per_turn_user_simulator_quality_v1',
  MULTI_TURN_TASK_SUCCESS_V1 = 'multi_turn_task_success_v1',
  MULTI_TURN_TRAJECTORY_QUALITY_V1 = 'multi_turn_trajectory_quality_v1',
  MULTI_TURN_TOOL_USE_QUALITY_V1 = 'multi_turn_tool_use_quality_v1',
  RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1 = 'rubric_based_multi_turn_trajectory_quality_v1',
}

/** A range of numeric values, e.g. `[0, 1]`, `(2, 3)` or `[-1, 6)`. */
export interface Interval {
  /** The smaller end of the interval. */
  minValue: number;

  /** The interval is open at the min end. Defaults to false (closed). */
  openAtMin?: boolean;

  /** The larger end of the interval. */
  maxValue: number;

  /** The interval is open at the max end. Defaults to false (closed). */
  openAtMax?: boolean;
}

/** The nature of the values a metric reports. */
export interface MetricValueInfo {
  /** Present when the metric reports values drawn from an interval. */
  interval?: Interval;
}

/** What the eval framework knows about a metric. */
export interface MetricInfo {
  metricName: string;

  /** A two to three line description of the metric. */
  description?: string;

  metricValueInfo: MetricValueInfo;
}

/** Implemented by anything that describes a metric to the eval framework. */
export interface MetricInfoProvider {
  /** Returns the {@link MetricInfo} for the metric this provider owns. */
  getMetricInfo(): MetricInfo;
}

const intervalSchema = z.strictObject({
  minValue: z.number(),
  openAtMin: z.boolean().default(false),
  maxValue: z.number(),
  openAtMax: z.boolean().default(false),
});

const metricInfoSchema = z.strictObject({
  metricName: z.string(),
  description: z.string().optional(),
  metricValueInfo: z.strictObject({interval: intervalSchema.optional()}),
});

/**
 * Validates a metric info payload.
 *
 * @throws {InputValidationError} When the payload omits `metricName` or
 *   `metricValueInfo`, or carries a key the shape does not declare.
 */
export function parseMetricInfo(raw: unknown): MetricInfo {
  const result = metricInfoSchema.safeParse(raw);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid MetricInfo: ${result.error.message}`,
    );
  }
  return result.data;
}
