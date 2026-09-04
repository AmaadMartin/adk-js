/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ConversationScenario, Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import type {RubricScore} from './eval_rubrics.js';

/**
 * The verdict a metric returns for an invocation, or for a whole eval case.
 *
 * The numeric values match the `EvalStatus` of `google/adk-python`, so a
 * serialized status is portable between the two runtimes. The enum lives in
 * `eval_metrics.ts`, and is re-exported here so that a metric reads its whole
 * contract from this module.
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

  /**
   * The rubrics a rubric-based metric assessed for this invocation. Absent
   * when no rubric assessment happened.
   */
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

  /**
   * The rubric scores aggregated over the invocations. Absent when no rubric
   * assessment happened.
   */
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
   * @param conversationScenario The scenario a simulated user drove, for a
   *   multi-turn conversation. Absent for a static conversation.
   */
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult | Promise<EvaluationResult>;
}
