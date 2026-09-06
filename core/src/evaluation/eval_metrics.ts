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

/**
 * The metrics this package implements.
 *
 * `adk-python` names more prebuilt metrics. Each is added here with the
 * evaluator that implements it.
 */
export enum PrebuiltMetrics {
  RESPONSE_EVALUATION_SCORE = 'response_evaluation_score',
  RESPONSE_MATCH_SCORE = 'response_match_score',
}

/** The criterion an eval metric is scored against. */
export interface BaseCriterion {
  /** The threshold the metric compares its score against. */
  threshold: number;
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
