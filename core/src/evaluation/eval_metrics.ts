/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';

/** The verdict for one metric, or for a whole eval case. */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

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

/** The value a metric's score is compared against to decide pass from fail. */
export type Threshold = number;

/**
 * The criterion a metric is judged against.
 *
 * Metrics that need more than a threshold extend this. A criterion read from a
 * config file keeps the fields this interface does not name, so an evaluator
 * can read its own criterion out of a value validated as a base one.
 */
export interface BaseCriterion {
  /** The threshold to be used by the metric. */
  threshold: Threshold;

  /**
   * Whether to judge the intermediate text an agent emits before its tool
   * calls together with its final response. Defaults to false, which judges
   * the final response alone.
   */
  includeIntermediateResponsesInFinal?: boolean;
}

/** A metric used to evaluate one aspect of an eval case. */
export interface EvalMetric {
  metricName: string;

  /**
   * @deprecated Use {@link criterion} instead.
   */
  threshold?: number;

  /** The criterion the metric is judged against. */
  criterion?: BaseCriterion;
}

/**
 * Returns the threshold configured for a metric.
 *
 * The criterion threshold wins over the metric-level one.
 *
 * @throws {InputValidationError} When the metric carries neither a criterion
 *   nor a threshold.
 */
export function getMetricThreshold(evalMetric: EvalMetric): number {
  if (evalMetric.criterion !== undefined) {
    return evalMetric.criterion.threshold;
  }
  if (evalMetric.threshold !== undefined) {
    return evalMetric.threshold;
  }

  throw new InputValidationError(
    `Evaluation metric '${evalMetric.metricName}' requires a threshold.`,
  );
}
