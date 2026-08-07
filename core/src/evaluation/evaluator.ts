/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Provided by evaluation sub-port #1 (evaluator base); minimal stand-in pending
// merge. Faithful port of adk-python `evaluation/evaluator.py`. Kept here so
// this sub-port compiles and its tests run before #1 lands.
// simplicity: the result records are plain interfaces (constructed as object
// literals, never re-parsed), matching how the evaluators build and read them.

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import {RubricScore} from './eval_rubrics.js';

export {EvalStatus} from './eval_metrics.js';

/**
 * Metric evaluation score for a single invocation.
 */
export interface PerInvocationResult {
  /** The actual invocation obtained from the agent under test. */
  actualInvocation: Invocation;
  /** The expected (reference/golden) invocation, if any. */
  expectedInvocation?: Invocation;
  /** Score obtained for this invocation, if it was evaluated. */
  score?: number;
  /** The status of this invocation's evaluation. */
  evalStatus: EvalStatus;
  /** Per-rubric scores obtained for this invocation, if any. */
  rubricScores?: RubricScore[];
}

/**
 * The result of evaluating a metric over a set of invocations.
 */
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

/**
 * Rejects invocation lists that cannot be paired without truncation.
 *
 * @throws {Error} If `expectedInvocations` is provided and its length differs
 *   from `actualInvocations`.
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
      'actualInvocations and expectedInvocations must have the same length;' +
        ` got ${actualInvocations.length} and ${expectedInvocations.length}.`,
    );
  }
}

/**
 * A metrics evaluator interface.
 */
export abstract class Evaluator {
  /**
   * Returns an {@link EvaluationResult} after evaluating the actual (and
   * optionally expected) invocations.
   *
   * @param actualInvocations Invocations obtained from the agent under test.
   * @param expectedInvocations Optional benchmark/golden invocations. When
   *   provided, they are usually expected to align 1:1 with the actual
   *   invocations.
   * @param conversationScenario Optional conversation scenario for multi-turn
   *   conversations.
   */
  abstract evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult>;
}
