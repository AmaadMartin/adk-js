/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {Invocation} from './eval_case.js';
import type {RubricScore} from './eval_rubrics.js';

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

/**
 * How actual tool calls are matched against the expected trajectory.
 *
 * The member names are the names of adk-python's `MatchType`, which its
 * criterion accepts as strings under `match_type`. That is where this enum
 * crosses the language boundary.
 */
export enum ToolTrajectoryMatchType {
  /** The actual calls equal the expected ones, none extra and none missing. */
  EXACT = 'EXACT',

  /**
   * Every expected call appears in the actual calls in the expected order.
   * Extra actual calls in between are tolerated.
   */
  IN_ORDER = 'IN_ORDER',

  /**
   * Every expected call appears in the actual calls in any order, respecting
   * multiplicity. Extra actual calls are tolerated.
   */
  ANY_ORDER = 'ANY_ORDER',
}

/** Criterion for scoring a tool trajectory against a reference one. */
export interface ToolTrajectoryCriterion extends BaseCriterion {
  /**
   * Defaults to {@link ToolTrajectoryMatchType.EXACT}. Accepts the enum, or a
   * string spelling such as `'in order'`, `'IN-ORDER'` or `'in_order'`.
   */
  matchType?: ToolTrajectoryMatchType | string;
}

/** A metric used to evaluate one aspect of an eval case. */
export interface EvalMetric {
  metricName: string;

  /**
   * @deprecated Use {@link criterion} instead.
   */
  threshold?: number;

  /**
   * The criterion the metric is judged against.
   *
   * The union names every concrete criterion a config can carry, so that a
   * criterion literal carrying metric-specific fields type-checks here.
   */
  criterion?: BaseCriterion | ToolTrajectoryCriterion;

  /** Path to the scoring function, when this is a custom metric. */
  customFunctionPath?: string;
}

/** The metric-specific detail behind a score. */
export interface EvalMetricResultDetails {
  /** Per-rubric scores, when the metric assessed rubrics. */
  rubricScores?: RubricScore[];
}

/** The computed value of an {@link EvalMetric}. */
export interface EvalMetricResult extends EvalMetric {
  /** Undefined when the metric was not evaluated. */
  score?: number;

  evalStatus: EvalStatus;

  /** How the score was arrived at. Absent when the metric reports none. */
  details?: EvalMetricResultDetails;
}

/** The metric results for a single invocation. */
export interface EvalMetricResultPerInvocation {
  /** The invocation obtained by inferencing the agent. */
  actualInvocation: Invocation;

  /** The reference invocation, when the eval case recorded one. */
  expectedInvocation?: Invocation;

  evalMetricResults: EvalMetricResult[];
}

const MATCH_TYPES_BY_NAME = new Map<string, ToolTrajectoryMatchType>(
  Object.values(ToolTrajectoryMatchType).map((matchType) => [
    matchType,
    matchType,
  ]),
);

/**
 * Returns the match type a value names, or `undefined` when it names none.
 *
 * An absent value reads as {@link ToolTrajectoryMatchType.EXACT}, the field
 * default. A string is trimmed, upper-cased, and its dashes and spaces read
 * as underscores, so `'any order'` and `'ANY-ORDER'` both resolve.
 */
export function normalizeToolTrajectoryMatchType(
  value: unknown,
): ToolTrajectoryMatchType | undefined {
  if (value === undefined) {
    return ToolTrajectoryMatchType.EXACT;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  return MATCH_TYPES_BY_NAME.get(
    value.trim().toUpperCase().replace(/[- ]/g, '_'),
  );
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
