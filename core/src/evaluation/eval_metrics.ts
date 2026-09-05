/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';

/** Base criterion to use for an eval metric. */
export interface BaseCriterion {
  /** The threshold at or above which the metric passes. */
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

/** A metric used to evaluate a particular aspect of an eval case. */
export interface EvalMetric {
  /** The name of the metric. */
  metricName: string;

  /**
   * A threshold value, which each metric interprets in its own way.
   *
   * @deprecated Use {@link EvalMetric.criterion} instead.
   */
  threshold?: number;

  /**
   * Evaluation criterion used by the metric.
   *
   * The union names every concrete criterion a config can carry, so that a
   * criterion literal carrying metric-specific fields type-checks here.
   */
  criterion?: BaseCriterion | ToolTrajectoryCriterion;
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
 * Returns the threshold a metric is configured with.
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
