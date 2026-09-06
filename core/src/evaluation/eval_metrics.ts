/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation} from './eval_case.js';
import {RubricScore} from './eval_rubrics.js';

/**
 * The outcome of an evaluation.
 *
 * `NOT_EVALUATED` is neither a pass nor a failure: a metric reports it when it
 * could not score the case at all. Test for `EvalStatus.PASSED` rather than
 * for `!== EvalStatus.FAILED`, or an unscored case counts as a pass.
 *
 * The numeric values match adk-python's `EvalStatus`, because they appear in
 * serialized eval results.
 */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/**
 * Base criterion that an eval metric applies.
 */
export interface BaseCriterion {
  /** The threshold that the metric uses. */
  threshold: number;

  /**
   * Whether to evaluate the full agent response, including the intermediate
   * text that the agent emits before a tool call, and not only the final
   * response. Defaults to false.
   */
  includeIntermediateResponsesInFinal?: boolean;
}

/**
 * A metric that evaluates one aspect of an eval case.
 */
export interface EvalMetric {
  /** The name of the metric. */
  metricName: string;

  /**
   * A threshold value. Each metric decides how to interpret it.
   *
   * adk-python reads this field when `criterion` is absent, so a metric that
   * adk-python wrote can still carry it.
   *
   * @deprecated Use `criterion` instead.
   */
  threshold?: number;

  /** The evaluation criterion that the metric uses. */
  criterion?: BaseCriterion;

  /** Path to the custom function, if this is a custom metric. */
  customFunctionPath?: string;
}

/**
 * Supporting detail for a metric result.
 */
export interface EvalMetricResultDetails {
  /** The scores obtained after applying the rubrics to the agent's response. */
  rubricScores?: RubricScore[];
}

/**
 * The computed value of a metric for an eval case.
 */
export interface EvalMetricResult extends EvalMetric {
  /**
   * Score obtained after evaluating the metric. Absent when the evaluation did
   * not happen.
   */
  score?: number;

  /** The status of this evaluation. */
  evalStatus: EvalStatus;

  /** Supporting detail for the score. Defaults to an empty object. */
  details?: EvalMetricResultDetails;
}

/**
 * The metric results for a single invocation.
 */
export interface EvalMetricResultPerInvocation {
  /** The actual invocation, usually obtained by running the agent. */
  actualInvocation: Invocation;

  /** The expected, or golden, invocation. */
  expectedInvocation?: Invocation;

  /** The result of each applicable metric. Defaults to an empty list. */
  evalMetricResults?: EvalMetricResult[];
}
