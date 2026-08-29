/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {Invocation} from './eval_case.js';

/** The verdict a metric returns for an invocation, or for a whole eval case. */
export enum EvalStatus {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  NOT_EVALUATED = 'NOT_EVALUATED',
}

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
}

/** The outcome of applying one metric to a list of invocations. */
export interface EvaluationResult {
  /** Overall score, averaged over invocations. Absent if nothing was evaluated. */
  overallScore?: number;

  /** Overall status, derived from the overall score. */
  overallEvalStatus: EvalStatus;

  /** Detailed results per invocation. */
  perInvocationResults: PerInvocationResult[];
}

/** The interface behind every evaluation metric. */
export interface Evaluator {
  /**
   * Scores the actual invocations, optionally against golden ones.
   *
   * @param actualInvocations The invocations obtained from the agent under
   *   test.
   * @param expectedInvocations Golden invocations. When supplied, the list must
   *   have the same length as `actualInvocations`.
   */
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): EvaluationResult | Promise<EvaluationResult>;
}

/**
 * Rejects invocation lists that cannot be paired without truncation.
 *
 * @throws {InputValidationError} When `expectedInvocations` is supplied and its
 *   length differs from `actualInvocations`.
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
