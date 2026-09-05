/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import type {ConversationScenario} from './conversation_scenarios.js';
import type {Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';

/**
 * The verdict a metric returns for an invocation, or for a whole eval case.
 *
 * Re-exported from `eval_metrics.js`, so that a metric and the eval service
 * report the same status values.
 */
export {EvalStatus};

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
   * @param expectedInvocations Golden invocations. A metric that needs them
   *   rejects the call when they are absent. When supplied, the list must
   *   have the same length as `actualInvocations`.
   * @param conversationScenario The scenario a simulated user played out to
   *   produce the invocations. A metric that scores how closely the agent
   *   followed the scenario reads it; every other metric ignores it. It sits
   *   on the shared contract so that one caller drives either kind of metric.
   */
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
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
