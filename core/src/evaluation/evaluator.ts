/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';
import {Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';

/** The score a metric gave to a single invocation. */
export interface PerInvocationResult {
  /** The invocation obtained from the agent under test. */
  actualInvocation: Invocation;

  /** The golden invocation this one was compared against, if any. */
  expectedInvocation?: Invocation;

  /** The score, absent when the invocation could not be scored. */
  score?: number;

  /** The status derived from the score and the metric's threshold. */
  evalStatus: EvalStatus;
}

/** The result of evaluating a metric over a list of invocations. */
export interface EvaluationResult {
  /** Overall score, based on each invocation. */
  overallScore?: number;

  /** Overall status, based on each invocation. */
  overallEvalStatus: EvalStatus;

  /** Detailed results per invocation. */
  perInvocationResults: PerInvocationResult[];
}

/** A metrics evaluator. */
export abstract class Evaluator {
  /**
   * Scores the invocations of the agent under test.
   *
   * @param actualInvocations The invocations obtained from the agent under
   *     test.
   * @param expectedInvocations An optional list of golden invocations. When
   *     given, it usually has the same length as `actualInvocations`.
   */
  abstract evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult>;
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
 * @throws InputValidationError if both lists are given and their lengths
 *     differ.
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
      'actualInvocations and expectedInvocations must have the same length;' +
        ` got ${actualInvocations.length} and ${expectedInvocations.length}.`,
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
