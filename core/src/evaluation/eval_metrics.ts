/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {isRecord} from '../utils/record_utils.js';

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

  /**
   * When true only tool names are compared and arguments are ignored.
   * Defaults to false.
   */
  ignoreArgs?: boolean;
}

/**
 * A {@link ToolTrajectoryCriterion} that has been validated, so its match type
 * is a member of the enum and its `ignoreArgs` is set.
 */
export interface ParsedToolTrajectoryCriterion extends ToolTrajectoryCriterion {
  matchType: ToolTrajectoryMatchType;
  ignoreArgs: boolean;
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

const CRITERION_PREFIX = 'A tool trajectory criterion';

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

/**
 * Returns the value a criterion payload holds under `camelKey`, falling back
 * to the snake_case `snakeKey`.
 *
 * adk-python's criterion model populates by field name as well as by camelCase
 * alias, so a config written for it may spell a key either way.
 */
function readCriterionKey(
  raw: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): unknown {
  return camelKey in raw ? raw[camelKey] : raw[snakeKey];
}

/**
 * Validates a criterion payload read from an eval config, and applies its
 * defaults.
 *
 * Keys the criterion does not name survive, matching adk-python's criterion
 * model, which allows extra fields.
 *
 * @throws {InputValidationError} When the payload carries no numeric
 *   `threshold`, names an unresolvable match type, or carries a non-boolean
 *   `ignoreArgs`.
 */
export function parseToolTrajectoryCriterion(
  raw: unknown,
): ParsedToolTrajectoryCriterion {
  if (!isRecord(raw)) {
    throw new InputValidationError(`${CRITERION_PREFIX} must be an object.`);
  }

  const threshold = raw['threshold'];
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new InputValidationError(
      `${CRITERION_PREFIX} requires a numeric \`threshold\`.`,
    );
  }

  const matchType = normalizeToolTrajectoryMatchType(
    readCriterionKey(raw, 'matchType', 'match_type'),
  );
  if (matchType === undefined) {
    throw new InputValidationError(
      `${CRITERION_PREFIX} accepts as \`matchType\` one of ` +
        `${Object.values(ToolTrajectoryMatchType).join(', ')}.`,
    );
  }

  const ignoreArgs = readCriterionKey(raw, 'ignoreArgs', 'ignore_args');
  if (ignoreArgs !== undefined && typeof ignoreArgs !== 'boolean') {
    throw new InputValidationError(
      `${CRITERION_PREFIX} requires \`ignoreArgs\` to be a boolean.`,
    );
  }

  return {...raw, threshold, matchType, ignoreArgs: ignoreArgs ?? false};
}
