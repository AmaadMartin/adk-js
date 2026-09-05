/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import type {ConversationScenario, Invocation} from './eval_case.js';
import type {BaseCriterion} from './eval_metrics.js';

/**
 * The verdict a metric returns for an invocation, or for a whole eval case.
 *
 * The numeric values match the `EvalStatus` of `google/adk-python`, so a
 * serialized status is portable between the two runtimes.
 */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
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
  /** Overall score, based on each invocation. */
  overallScore?: number;

  /** Overall status, based on each invocation. */
  overallEvalStatus: EvalStatus;

  /** Detailed results per invocation. */
  perInvocationResults: PerInvocationResult[];
}

/**
 * The criterion type a metric accepts, which a metric class names in a
 * `static readonly criterionType`. A criterion arrives untyped, from a
 * user-authored eval config file.
 */
export interface CriterionType<C extends BaseCriterion = BaseCriterion> {
  /** The type name reported when a criterion does not fit. */
  readonly name: string;

  /** @throws {InputValidationError} When the value is not of this type. */
  validate(value: unknown): C;
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
