/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation} from './eval_case.js';

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

/**
 * The criterion a metric is judged against.
 *
 * Metrics that need more than a threshold extend this, so a criterion read
 * from a config file can carry fields this interface does not name.
 */
export interface BaseCriterion {
  threshold: number;
}

/** A metric used to evaluate one aspect of an eval case. */
export interface EvalMetric {
  metricName: string;

  /**
   * How the metric is judged. Required, so that a metric cannot reach a
   * verdict with no threshold to compare against. adk-python also carries a
   * bare `threshold`, which it documents as on its way out.
   */
  criterion: BaseCriterion;

  /** Path to the scoring function, when this is a custom metric. */
  customFunctionPath?: string;
}

/** The computed value of an {@link EvalMetric}. */
export interface EvalMetricResult extends EvalMetric {
  /** Undefined when the metric was not evaluated. */
  score?: number;

  evalStatus: EvalStatus;
}

/** The metric results for a single invocation. */
export interface EvalMetricResultPerInvocation {
  /** The invocation obtained by inferencing the agent. */
  actualInvocation: Invocation;

  /** The reference invocation, when the eval case recorded one. */
  expectedInvocation?: Invocation;

  evalMetricResults: EvalMetricResult[];
}
