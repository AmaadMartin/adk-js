/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {Invocation} from './eval_case.js';
import {EvalMetric, getMetricThreshold} from './eval_metrics.js';
import {
  emptyEvaluationResult,
  EvaluationResult,
  Evaluator,
  getEvalStatus,
  getTextFromContent,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';
import {rouge1Score} from './rouge_scorer.js';

/**
 * Scores an agent's final response against a golden final response with the
 * ROUGE-1 metric.
 *
 * Scores range over [0, 1], and a score closer to 1 is more desirable.
 */
export class RougeEvaluator extends Evaluator {
  private readonly threshold: number;

  constructor(evalMetric: EvalMetric) {
    super();
    this.threshold = getMetricThreshold(evalMetric);
  }

  /**
   * @throws InputValidationError if `expectedInvocations` is absent, or if it
   *     has a different length than `actualInvocations`.
   */
  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult> {
    if (expectedInvocations === undefined) {
      throw new InputValidationError(
        'expectedInvocations is required for this metric.',
      );
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const perInvocationResults: PerInvocationResult[] = [];
    let totalScore = 0;
    for (const [index, actual] of actualInvocations.entries()) {
      const expected = expectedInvocations[index];
      const score = rouge1Score(
        getTextFromContent(actual.finalResponse),
        getTextFromContent(expected.finalResponse),
      ).fmeasure;
      totalScore += score;
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation: expected,
        score,
        evalStatus: getEvalStatus(score, this.threshold),
      });
    }

    if (perInvocationResults.length === 0) {
      return emptyEvaluationResult();
    }

    const overallScore = totalScore / perInvocationResults.length;
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults,
    };
  }
}
