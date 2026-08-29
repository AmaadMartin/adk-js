/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall} from '@google/genai';
import {isEqual} from 'lodash-es';
import {InputValidationError} from '../errors/input_validation_error.js';
import {Invocation} from './eval_case.js';
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';

/** How actual and expected tool call trajectories are compared. */
export enum ToolTrajectoryMatchType {
  /** The actual calls equal the expected ones, with none extra or missing. */
  EXACT = 'exact',

  /**
   * Every expected call appears in the actual calls in the same relative
   * order. Extra actual calls are allowed in between.
   */
  IN_ORDER = 'in_order',

  /**
   * Every expected call appears in the actual calls in any order, respecting
   * multiplicity. Extra actual calls are allowed.
   */
  ANY_ORDER = 'any_order',
}

/** Options for {@link TrajectoryEvaluator}. */
export interface TrajectoryEvaluatorOptions {
  /** Score at or above which an invocation passes. */
  threshold: number;

  /** How actual and expected tool calls are compared. Defaults to `EXACT`. */
  matchType?: ToolTrajectoryMatchType;
}

/**
 * Two tool calls are equal when their name and arguments are equal.
 *
 * The call `id` never takes part: it is assigned per run, so a golden
 * trajectory cannot predict it. An omitted `args` is read as `{}`, following
 * the existing comparison in
 * `agents/processors/request_confirmation_llm_request_processor.ts`.
 */
function areCallsEqual(a: FunctionCall, b: FunctionCall): boolean {
  return a.name === b.name && isEqual(a.args ?? {}, b.args ?? {});
}

function isExactMatch(
  actual: FunctionCall[],
  expected: FunctionCall[],
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }

  return actual.every((call, index) => areCallsEqual(call, expected[index]));
}

function isInOrderMatch(
  actual: FunctionCall[],
  expected: FunctionCall[],
): boolean {
  let cursor = 0;
  for (const call of actual) {
    if (cursor < expected.length && areCallsEqual(call, expected[cursor])) {
      cursor++;
    }
  }

  return cursor === expected.length;
}

function isAnyOrderMatch(
  actual: FunctionCall[],
  expected: FunctionCall[],
): boolean {
  // Matched calls are consumed, so an expected call that repeats needs the
  // actual list to hold it as many times.
  const remaining = [...actual];
  for (const call of expected) {
    const index = remaining.findIndex((candidate) =>
      areCallsEqual(candidate, call),
    );
    if (index === -1) {
      return false;
    }
    remaining.splice(index, 1);
  }

  return true;
}

const TOOL_TRAJECTORY_MATCHERS: Record<
  ToolTrajectoryMatchType,
  (actual: FunctionCall[], expected: FunctionCall[]) => boolean
> = {
  [ToolTrajectoryMatchType.EXACT]: isExactMatch,
  [ToolTrajectoryMatchType.IN_ORDER]: isInOrderMatch,
  [ToolTrajectoryMatchType.ANY_ORDER]: isAnyOrderMatch,
};

const MATCH_TYPES_BY_NAME = new Map<string, ToolTrajectoryMatchType>(
  Object.values(ToolTrajectoryMatchType).map((matchType) => [
    matchType.toUpperCase(),
    matchType,
  ]),
);

/**
 * Resolves a configured match type written as a string.
 *
 * Case, surrounding blanks, hyphens and spaces are all accepted, so `ANY
 * ORDER`, `any-order` and `any_order` all resolve to
 * {@link ToolTrajectoryMatchType.ANY_ORDER}.
 *
 * @throws {InputValidationError} When the string names no match type.
 */
export function parseToolTrajectoryMatchType(
  value: string,
): ToolTrajectoryMatchType {
  const normalized = value.trim().toUpperCase().replace(/[- ]/g, '_');
  const matchType = MATCH_TYPES_BY_NAME.get(normalized);
  if (matchType === undefined) {
    throw new InputValidationError(
      `Unknown tool trajectory match type: ${value}.`,
    );
  }

  return matchType;
}

/**
 * Scores an agent's tool use trajectory against an expected one.
 *
 * An invocation scores 1.0 when its tool calls match the expected calls under
 * the configured match type, and 0.0 otherwise. The overall score is the mean
 * across invocations, and a score at or above the threshold passes.
 */
export class TrajectoryEvaluator implements Evaluator {
  private readonly threshold: number;
  private readonly matchType: ToolTrajectoryMatchType;

  constructor(options: TrajectoryEvaluatorOptions) {
    this.threshold = options.threshold;
    this.matchType = options.matchType ?? ToolTrajectoryMatchType.EXACT;
  }

  /**
   * Scores each actual invocation against its expected counterpart.
   *
   * @throws {InputValidationError} When `expectedInvocations` is missing, or
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

    const scores = actualInvocations.map((actual, index) =>
      this.scoreInvocation(actual, expectedInvocations[index]),
    );
    const perInvocationResults: PerInvocationResult[] = actualInvocations.map(
      (actual, index) => ({
        actualInvocation: actual,
        expectedInvocation: expectedInvocations[index],
        score: scores[index],
        evalStatus: this.getEvalStatus(scores[index]),
      }),
    );

    if (scores.length === 0) {
      return {
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults,
      };
    }

    const overallScore =
      scores.reduce((total, score) => total + score, 0) / scores.length;

    return {
      overallScore,
      overallEvalStatus: this.getEvalStatus(overallScore),
      perInvocationResults,
    };
  }

  private scoreInvocation(actual: Invocation, expected: Invocation): number {
    const matches = TOOL_TRAJECTORY_MATCHERS[this.matchType](
      actual.intermediateData?.toolUses ?? [],
      expected.intermediateData?.toolUses ?? [],
    );

    return matches ? 1.0 : 0.0;
  }

  private getEvalStatus(score: number): EvalStatus {
    return score >= this.threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
  }
}
