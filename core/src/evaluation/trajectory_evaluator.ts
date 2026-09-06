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
  EvalStatus,
  type EvaluationResult,
  type Evaluator,
  type PerInvocationResult,
} from './evaluator.js';

/**
 * How actual tool calls are matched against the expected trajectory.
 *
 * The names are the values an adk-python `eval_config.json` accepts under
 * `match_type`, which is where this enum crosses the language boundary.
 */
export enum ToolTrajectoryMatchType {
  /** The actual calls equal the expected ones, with none extra or missing. */
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

/** Options for {@link TrajectoryEvaluator}. */
export interface TrajectoryEvaluatorOptions {
  /** Minimum score at which the metric passes. Range [0, 1]. */
  threshold: number;

  /** Defaults to {@link ToolTrajectoryMatchType.EXACT}. */
  matchType?: ToolTrajectoryMatchType;
}

/**
 * Two tool calls are equal when their name and arguments are equal.
 *
 * The call `id` never takes part: a run assigns it, so a golden trajectory
 * cannot predict it. An omitted `args` reads as `{}`.
 */
function toolCallsEqual(a: FunctionCall, b: FunctionCall): boolean {
  return a.name === b.name && isEqual(a.args ?? {}, b.args ?? {});
}

/** Whether the two trajectories hold the same calls in the same order. */
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
  let cursor = 0;
  for (const call of actual) {
    if (cursor < expected.length && toolCallsEqual(call, expected[cursor])) {
      cursor++;
    }
  }

  return cursor === expected.length;
}

/**
 * Whether `actual` contains every expected call, in any order.
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

const TOOL_CALL_MATCHERS = new Map<ToolTrajectoryMatchType, ToolCallMatcher>([
  [ToolTrajectoryMatchType.EXACT, areToolCallsExactMatch],
  [ToolTrajectoryMatchType.IN_ORDER, areToolCallsInOrderMatch],
  [ToolTrajectoryMatchType.ANY_ORDER, areToolCallsAnyOrderMatch],
]);

/** A per-invocation result this metric always scores. */
type ScoredInvocationResult = PerInvocationResult & {score: number};

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
   * @throws {InputValidationError} When `matchType` is not one of
   *   {@link ToolTrajectoryMatchType}.
   */
  constructor(options: TrajectoryEvaluatorOptions) {
    const matchType = options.matchType ?? ToolTrajectoryMatchType.EXACT;
    const matches = TOOL_CALL_MATCHERS.get(matchType);
    if (!matches) {
      throw new InputValidationError(`Unsupported match type ${matchType}`);
    }

    this.threshold = options.threshold;
    this.matches = matches;
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
    if (actualInvocations.length !== expectedInvocations.length) {
      throw new InputValidationError(
        'actualInvocations and expectedInvocations must have the same length; ' +
          `got ${actualInvocations.length} and ${expectedInvocations.length}.`,
      );
    }

    const perInvocationResults: ScoredInvocationResult[] =
      actualInvocations.map((actualInvocation, index) => {
        const expectedInvocation = expectedInvocations[index];
        const score = this.matches(
          getAllToolCalls(actualInvocation.intermediateData),
          getAllToolCalls(expectedInvocation.intermediateData),
        )
          ? 1.0
          : 0.0;

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

    const overallScore =
      perInvocationResults.reduce((total, each) => total + each.score, 0) /
      perInvocationResults.length;

    return {
      overallScore,
      overallEvalStatus: this.getEvalStatus(overallScore),
      perInvocationResults,
    };
  }

  private getEvalStatus(score: number): EvalStatus {
    return score >= this.threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
  }
}
