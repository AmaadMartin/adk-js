/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation, InvocationSchema} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import {RubricScoreSchema} from './eval_rubrics.js';

// Re-exported for parity with adk-python, whose evaluator module re-exports
// EvalStatus so downstream evaluators/tests can import it from here.
export {EvalStatus} from './eval_metrics.js';
export type {BaseCriterion} from './eval_metrics.js';

/**
 * Rejects invocation lists that cannot be paired without truncation.
 *
 * @throws {Error} If `expectedInvocations` is provided and its length differs
 *     from `actualInvocations`.
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
      'actual_invocations and expected_invocations must have the same' +
        ` length; got ${actualInvocations.length} and` +
        ` ${expectedInvocations.length}.`,
    );
  }
}

/**
 * Metric evaluation score per invocation.
 */
export const PerInvocationResultSchema = z
  .object({
    /** The actual invocation, usually obtained by inferencing the agent. */
    actualInvocation: InvocationSchema,
    /** The expected (reference or golden) invocation. */
    expectedInvocation: InvocationSchema.optional(),
    /** Score obtained for this invocation. */
    score: z.number().optional(),
    /** The status of this evaluation. */
    evalStatus: z.enum(EvalStatus).default(EvalStatus.NOT_EVALUATED),
    /** Rubric scores obtained for this invocation. */
    rubricScores: z.array(RubricScoreSchema).optional(),
  })
  .strict();

/**
 * Metric evaluation score per invocation.
 */
export type PerInvocationResult = z.infer<typeof PerInvocationResultSchema>;

/**
 * The aggregate result of evaluating a metric across invocations.
 */
export const EvaluationResultSchema = z
  .object({
    /** Overall score, based on each invocation. */
    overallScore: z.number().optional(),
    /** Overall status, based on each invocation. */
    overallEvalStatus: z.enum(EvalStatus).default(EvalStatus.NOT_EVALUATED),
    /** Detailed results per invocation. */
    perInvocationResults: z.array(PerInvocationResultSchema).default(() => []),
    /** Overall rubric scores, based on each invocation. */
    overallRubricScores: z.array(RubricScoreSchema).optional(),
  })
  .strict();

/**
 * The aggregate result of evaluating a metric across invocations.
 */
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

/**
 * A metrics evaluator interface.
 *
 * Deterministic evaluators return an {@link EvaluationResult} synchronously,
 * while service-backed and custom-function evaluators return a Promise. The
 * union return type lets a single registry hand back either; consumers should
 * `await` the result, which is correct for both.
 */
export abstract class Evaluator {
  /**
   * Returns an {@link EvaluationResult} after evaluating actual and expected
   * invocations.
   *
   * @param actualInvocations Invocations obtained from the agent under test.
   * @param expectedInvocations Optional benchmark/golden invocations. When
   *     provided, they are expected to be the same length as
   *     `actualInvocations`.
   * @param conversationScenario Optional conversation scenario for multi-turn
   *     conversations.
   */
  abstract evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult | Promise<EvaluationResult>;
}
