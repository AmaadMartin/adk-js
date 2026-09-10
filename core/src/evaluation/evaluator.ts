/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import type {ConversationScenario} from './conversation_scenarios.js';
import type {Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';

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
  /** Overall score, based on each invocation. */
  overallScore?: number;

  /** Overall status, based on each invocation. */
  overallEvalStatus: EvalStatus;

  /** Detailed results per invocation. */
  perInvocationResults: PerInvocationResult[];
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

/**
 * Returns the status of a score. A caller that scored nothing reports
 * {@link EvalStatus.NOT_EVALUATED} itself, rather than asking here.
 */
export function getEvalStatus(score: number, threshold: number): EvalStatus {
  return score >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
}
