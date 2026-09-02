/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import type {ConversationScenario} from './conversation_scenarios.js';
import type {Invocation} from './eval_case.js';
import type {CriterionType} from './eval_metrics.js';
import {EvalStatus, parseBaseCriterion} from './eval_metrics.js';
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

  /** The per-rubric breakdown, when the metric is rubric-based. */
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

  /** The rubric scores aggregated over every invocation. */
  overallRubricScores?: RubricScore[];
}

/** A metrics evaluator. */
export abstract class Evaluator {
  /**
   * The criterion this evaluator is configured with. A subclass narrows it to
   * its own criterion and validates the config-supplied criterion against it,
   * as `Evaluator.criterion_type` does in adk-python.
   */
  static readonly criterionType: CriterionType = parseBaseCriterion;

  /**
   * Scores the actual invocations, optionally against golden ones.
   *
   * @param actualInvocations The invocations obtained from the agent under
   *   test.
   * @param expectedInvocations Golden invocations. A metric that needs them
   *   rejects the call when they are absent. When supplied, the list must
   *   have the same length as `actualInvocations`.
   * @param conversationScenario The scenario a multi-turn conversation
   *   followed. A single-turn metric ignores it.
   */
  abstract evaluateInvocations(
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
