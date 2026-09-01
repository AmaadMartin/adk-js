/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';

/** The outcome of evaluating a metric. */
export enum EvalStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  NOT_EVALUATED = 'NOT_EVALUATED',
}

/** The metrics that ADK ships with. */
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

/** The criterion an eval metric is scored against. */
export interface BaseCriterion {
  /** The threshold the metric compares its score against. */
  threshold: number;

  /**
   * Whether to evaluate the text of intermediate invocation events alongside
   * the final response.
   */
  includeIntermediateResponsesInFinal?: boolean;
}

/** A metric used to evaluate one aspect of an eval case. */
export interface EvalMetric {
  /** The name of the metric. */
  metricName: string;

  /**
   * A threshold value.
   *
   * @deprecated Use `criterion` instead.
   */
  threshold?: number;

  /** The evaluation criterion used by the metric. */
  criterion?: BaseCriterion;

  /** Path to the custom function, if this is a custom metric. */
  customFunctionPath?: string;
}

/**
 * Returns the threshold configured on the metric.
 *
 * @throws InputValidationError if the metric carries no threshold.
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
