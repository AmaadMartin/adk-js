/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';
import type {Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import type {RubricScore} from './eval_rubrics.js';

/** Metric evaluation score for one invocation. */
export interface PerInvocationResult {
  /** The invocation obtained from the agent under test. */
  actualInvocation: Invocation;

  /** The golden invocation the actual one was scored against. */
  expectedInvocation?: Invocation;

  /** The score the metric awarded. Absent when nothing was evaluated. */
  score?: number;

  /** The status of this invocation. */
  evalStatus: EvalStatus;

  /** Per-rubric scores, when the metric is rubric based. */
  rubricScores?: RubricScore[];
}

/** The outcome of applying one metric to a list of invocations. */
export interface EvaluationResult {
  /** Overall score, based on each invocation. */
  overallScore?: number;

  /** Overall status, based on each invocation. */
  overallEvalStatus: EvalStatus;

  /** Detailed results per invocation. */
  perInvocationResults: PerInvocationResult[];

  /** Overall rubric scores, based on each invocation. */
  overallRubricScores?: RubricScore[];
}

/** A metrics evaluator. */
export interface Evaluator {
  /**
   * Scores the actual invocations, optionally against golden ones.
   *
   * @param actualInvocations The invocations obtained from the agent under
   *   test.
   * @param expectedInvocations Golden invocations. A metric that needs them
   *   rejects the call when they are absent. When supplied, the list must
   *   have the same length as `actualInvocations`.
   */
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult | Promise<EvaluationResult>;
}

/** The result returned when nothing could be evaluated. */
export function emptyEvaluationResult(): EvaluationResult {
  return {
    overallEvalStatus: EvalStatus.NOT_EVALUATED,
    perInvocationResults: [],
  };
}

/**
 * Rejects invocation lists that cannot be paired without truncation.
 *
 * @throws {InputValidationError} When both lists are present and their
 *   lengths differ.
 */
export function validateInvocationLengths(
  actualInvocations: Invocation[],
  expectedInvocations?: Invocation[],
): void {
  if (
    expectedInvocations !== undefined &&
    actualInvocations.length !== expectedInvocations.length
  ) {
    throw new InputValidationError(
      'actualInvocations and expectedInvocations must have the same length; ' +
        `got ${actualInvocations.length} and ${expectedInvocations.length}.`,
    );
  }
}

/** Returns the status of a score, which is absent when nothing was scored. */
export function getEvalStatus(
  score: number | undefined,
  threshold: number,
): EvalStatus {
  if (score === undefined) {
    return EvalStatus.NOT_EVALUATED;
  }
  return score >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
}

/** Joins the text parts of a content with newlines. */
export function getTextFromContent(content?: Content): string {
  return (content?.parts ?? [])
    .flatMap((part) => (part.text ? [part.text] : []))
    .join('\n');
}
