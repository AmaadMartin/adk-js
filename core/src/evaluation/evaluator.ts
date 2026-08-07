/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';

// PROVISIONAL: This is a minimal, parity-faithful subset of the evaluation base
// types (ported from adk-python's `evaluator.py`). It is provided so this port
// is self-contained and buildable regardless of merge ordering. It is
// superseded by the full evaluation base modules (evaluation sub-ports #1/#2),
// which a later rebase reconciles.

export {EvalStatus} from './eval_metrics.js';

/**
 * Rejects invocation lists that cannot be paired without truncation.
 *
 * @throws If `expectedInvocations` is provided and its length differs from
 *   `actualInvocations`.
 */
export function validateInvocationLengths(
  actualInvocations: Invocation[],
  expectedInvocations?: Invocation[],
): void {
  if (
    expectedInvocations !== undefined &&
    actualInvocations.length !== expectedInvocations.length
  ) {
    throw new Error(
      'actualInvocations and expectedInvocations must have the same length; ' +
        `got ${actualInvocations.length} and ${expectedInvocations.length}.`,
    );
  }
}

/** Metric evaluation score per invocation. */
export interface PerInvocationResult {
  /** The actual invocation, usually obtained by inferencing the agent. */
  actualInvocation: Invocation;

  /** The expected (golden) invocation, if one was supplied. */
  expectedInvocation?: Invocation;

  /** Score obtained after evaluating the metric, or `null` if not evaluated. */
  score: number | null;

  /** The status of this evaluation. */
  evalStatus: EvalStatus;
}

/** The result of evaluating a metric over a sequence of invocations. */
export interface EvaluationResult {
  /** Overall score, based on each invocation, or `null` if not evaluated. */
  overallScore: number | null;

  /** Overall status, based on each invocation. */
  overallEvalStatus: EvalStatus;

  /** Detailed results per invocation. */
  perInvocationResults: PerInvocationResult[];
}

/** A metrics evaluator interface. */
export abstract class Evaluator {
  /**
   * Returns an `EvaluationResult` after evaluating actual (and optionally
   * expected) invocations.
   *
   * This is asynchronous because evaluating a metric typically requires I/O
   * (an eval service or a judge model round-trip).
   *
   * @param actualInvocations The invocations obtained from the agent under
   *   test.
   * @param expectedInvocations An optional list of golden invocations. When
   *   provided, it must have the same length as `actualInvocations`.
   * @param conversationScenario An optional conversation scenario for
   *   multi-turn conversations.
   */
  abstract evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: unknown,
  ): Promise<EvaluationResult>;
}
