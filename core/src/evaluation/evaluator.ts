/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';
import type {ConversationScenario, Invocation} from './eval_case.js';
import type {BaseCriterion} from './eval_metrics.js';
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

/** The name reported for the criterion type every metric accepts. */
const BASE_CRITERION_NAME = 'BaseCriterion';

const BASE_CRITERION_ERROR_MESSAGE =
  `A criterion of type \`${BASE_CRITERION_NAME}\` requires a numeric ` +
  '`threshold`.';

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

/**
 * The runtime handle for the criterion type a metric accepts.
 *
 * A criterion arrives untyped, from a user-authored eval config file. The
 * metric names the type it accepts, and that type turns the raw value into a
 * criterion or rejects it.
 */
export interface CriterionType<C extends BaseCriterion = BaseCriterion> {
  /** The type name reported when a criterion does not fit. */
  readonly name: string;

  /**
   * Returns the value as a criterion of this type.
   *
   * @throws {InputValidationError} When the value is not a criterion of this
   *   type.
   */
  validate(value: unknown): C;
}

function isBaseCriterion(value: unknown): value is BaseCriterion {
  return (
    typeof value === 'object' &&
    value !== null &&
    'threshold' in value &&
    Number.isFinite(value.threshold)
  );
}

/**
 * Returns the value as a {@link BaseCriterion}, keeping the keys this
 * interface does not name so that a subclass criterion survives the check.
 *
 * @throws {InputValidationError} When the value carries no numeric
 *   `threshold`.
 */
export function validateBaseCriterion(value: unknown): BaseCriterion {
  if (!isBaseCriterion(value)) {
    throw new InputValidationError(BASE_CRITERION_ERROR_MESSAGE);
  }
  return value;
}

/** The criterion type a metric accepts when it names no other. */
export const BASE_CRITERION_TYPE: CriterionType<BaseCriterion> = {
  name: BASE_CRITERION_NAME,
  validate: validateBaseCriterion,
};

/**
 * The static side of an evaluator class.
 *
 * A class names the criterion type it accepts by declaring
 * `static readonly criterionType`. A class that declares none accepts
 * {@link BASE_CRITERION_TYPE}.
 */
export interface EvaluatorClass<C extends BaseCriterion = BaseCriterion> {
  /** The class name, which every class carries. */
  readonly name: string;

  readonly criterionType?: CriterionType<C>;
}

/** Returns the criterion type a class names, or the default one. */
export function getCriterionType(
  evaluatorClass: EvaluatorClass,
): CriterionType<BaseCriterion> {
  return evaluatorClass.criterionType ?? BASE_CRITERION_TYPE;
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
