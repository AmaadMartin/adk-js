/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionCall} from '@google/genai';
import {isEqual} from 'lodash-es';
import {InputValidationError} from '../errors/input_validation_error.js';
import {getAllToolCalls, type Invocation} from './eval_case.js';
import {
  getMetricThreshold,
  normalizeToolTrajectoryMatchType,
  ToolTrajectoryMatchType,
  type BaseCriterion,
  type EvalMetric,
  type ToolTrajectoryCriterion,
} from './eval_metrics.js';
import {
  EvalStatus,
  validateInvocationLengths,
  type EvaluationResult,
  type Evaluator,
  type PerInvocationResult,
} from './evaluator.js';

/**
 * Options for {@link TrajectoryEvaluator}.
 *
 * Supply exactly one of the two: a plain threshold, or the metric the
 * evaluator reads its threshold and match type from.
 */
export interface TrajectoryEvaluatorOptions {
  /** Minimum score at which the metric passes. Range [0, 1]. */
  threshold?: number;

  /** A metric parsed from an eval config. */
  evalMetric?: EvalMetric;
}

/**
 * Two tool calls are equal when their name and arguments are equal.
 *
 * The call `id` never takes part: a run assigns it, so a golden trajectory
 * cannot predict it. An omitted `args` reads as `{}`.
 */
function toolCallsEqual(actual: FunctionCall, expected: FunctionCall): boolean {
  return (
    actual.name === expected.name &&
    isEqual(actual.args ?? {}, expected.args ?? {})
  );
}

/** Whether both trajectories hold the same calls in the same order. */
export function areToolCallsExactMatch(
  actual: FunctionCall[],
  expected: FunctionCall[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((call, index) => toolCallsEqual(call, expected[index]))
  );
}

/**
 * Whether every expected call appears in `actual` in the expected order.
 *
 * Extra actual calls between the expected ones are tolerated, and an empty
 * expected trajectory matches anything.
 */
export function areToolCallsInOrderMatch(
  actual: FunctionCall[],
  expected: FunctionCall[],
): boolean {
  let matched = 0;
  for (const call of actual) {
    if (matched < expected.length && toolCallsEqual(call, expected[matched])) {
      matched++;
    }
  }

  return matched === expected.length;
}

/**
 * Whether `actual` holds every expected call, in any order.
 *
 * A matched call is consumed, so an expected call that repeats needs the
 * actual trajectory to hold it as many times.
 */
export function areToolCallsAnyOrderMatch(
  actual: FunctionCall[],
  expected: FunctionCall[],
): boolean {
  const remaining = [...actual];
  for (const call of expected) {
    const index = remaining.findIndex((candidate) =>
      toolCallsEqual(candidate, call),
    );
    if (index === -1) {
      return false;
    }
    remaining.splice(index, 1);
  }

  return true;
}

/** Compares an actual tool call trajectory with an expected one. */
type ToolCallMatcher = (
  actual: FunctionCall[],
  expected: FunctionCall[],
) => boolean;

const TOOL_CALL_MATCHERS: Record<ToolTrajectoryMatchType, ToolCallMatcher> = {
  [ToolTrajectoryMatchType.EXACT]: areToolCallsExactMatch,
  [ToolTrajectoryMatchType.IN_ORDER]: areToolCallsInOrderMatch,
  [ToolTrajectoryMatchType.ANY_ORDER]: areToolCallsAnyOrderMatch,
};

/** A per-invocation result this metric always scores. */
type ScoredInvocationResult = PerInvocationResult & {score: number};

/**
 * Returns the match type a criterion asks for, or `undefined` when the
 * criterion is not a usable {@link ToolTrajectoryCriterion}.
 *
 * A criterion parsed from a config file is untrusted, so its threshold is
 * checked at runtime as well.
 */
function resolveCriterionMatchType(
  criterion: BaseCriterion | ToolTrajectoryCriterion,
): ToolTrajectoryMatchType | undefined {
  if (!Number.isFinite(criterion.threshold)) {
    return undefined;
  }

  return normalizeToolTrajectoryMatchType(
    'matchType' in criterion ? criterion.matchType : undefined,
  );
}

/**
 * Scores an agent's tool use trajectory against a golden one.
 *
 * An invocation scores 1.0 when its tool calls match the expected calls under
 * the configured match type, and 0.0 otherwise. The overall score is the mean
 * over the invocations, and a score at or above the threshold passes.
 */
export class TrajectoryEvaluator implements Evaluator {
  private readonly threshold: number;
  private readonly matches: ToolCallMatcher;

  /**
   * @throws {InputValidationError} When both `threshold` and `evalMetric` are
   *   supplied, when neither is, or when the metric carries a criterion this
   *   metric cannot read.
   */
  constructor(options: TrajectoryEvaluatorOptions) {
    const {threshold, evalMetric} = options;
    if (threshold !== undefined && evalMetric !== undefined) {
      throw new InputValidationError(
        'Either evalMetric should be specified or threshold should be' +
          ' specified.',
      );
    }

    let matchType = ToolTrajectoryMatchType.EXACT;
    if (evalMetric?.criterion !== undefined) {
      const criterionMatchType = resolveCriterionMatchType(
        evalMetric.criterion,
      );
      if (criterionMatchType === undefined) {
        throw new InputValidationError(
          `\`${evalMetric.metricName}\` metric expects a criterion of type` +
            ' `ToolTrajectoryCriterion`.',
        );
      }
      this.threshold = evalMetric.criterion.threshold;
      matchType = criterionMatchType;
    } else if (evalMetric !== undefined) {
      this.threshold = getMetricThreshold(evalMetric);
    } else if (threshold !== undefined) {
      this.threshold = threshold;
    } else {
      throw new InputValidationError(
        'A trajectory evaluation threshold is required.',
      );
    }

    this.matches = TOOL_CALL_MATCHERS[matchType];
  }

  /**
   * Scores each actual invocation against its expected counterpart.
   *
   * Scoring an empty list evaluates nothing: the result carries no overall
   * score and the status {@link EvalStatus.NOT_EVALUATED}.
   *
   * @throws {InputValidationError} When `expectedInvocations` is absent, or
   *   when the two lists have different lengths.
   */
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult {
    if (expectedInvocations === undefined) {
      throw new InputValidationError(
        'expectedInvocations is needed by this metric.',
      );
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const perInvocationResults: ScoredInvocationResult[] =
      actualInvocations.map((actualInvocation, index) => {
        const expectedInvocation = expectedInvocations[index];
        const score = this.scoreInvocation(
          actualInvocation,
          expectedInvocation,
        );

        return {
          actualInvocation,
          expectedInvocation,
          score,
          evalStatus: this.getEvalStatus(score),
        };
      });

    if (perInvocationResults.length === 0) {
      return {
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults,
      };
    }

    const total = perInvocationResults.reduce(
      (sum, result) => sum + result.score,
      0,
    );
    const overallScore = total / perInvocationResults.length;

    return {
      overallScore,
      overallEvalStatus: this.getEvalStatus(overallScore),
      perInvocationResults,
    };
  }

  private scoreInvocation(
    actualInvocation: Invocation,
    expectedInvocation: Invocation,
  ): number {
    return this.matches(
      getAllToolCalls(actualInvocation.intermediateData),
      getAllToolCalls(expectedInvocation.intermediateData),
    )
      ? 1.0
      : 0.0;
  }

  private getEvalStatus(score: number): EvalStatus {
    return score >= this.threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
  }
}
