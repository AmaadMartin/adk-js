/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content} from '@google/genai';
import {Invocation} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import {
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';

/** One prompt/response pair to score, with an optional golden reference. */
export interface VertexEvalCaseRow {
  prompt: string;
  reference?: string;
  response: string;
}

/** The rows submitted in one evaluation request. */
export interface VertexEvaluationDataset {
  evalDataset: VertexEvalCaseRow[];
}

/** The name of a metric to run over the dataset. */
export interface VertexEvalMetricSpec {
  name: string;
}

/** A metric result aggregated over the rows of the dataset. */
export interface VertexAggregatedMetricResult {
  meanScore?: number;
}

/** The result of one evaluation request. */
export interface VertexEvaluationResult {
  summaryMetrics?: VertexAggregatedMetricResult[];
}

/** One evaluation request. */
export interface VertexAiEvalRequest {
  dataset: VertexEvaluationDataset;
  metrics: VertexEvalMetricSpec[];
}

/**
 * The Vertex AI Gen AI evaluation service, as this package uses it.
 *
 * The service has no JavaScript SDK, so the caller supplies the transport and
 * owns authentication.
 */
export interface VertexAiEvalClient {
  evaluate(request: VertexAiEvalRequest): Promise<VertexEvaluationResult>;
}

/** Options for {@link SingleTurnVertexAiEvalFacade}. */
export interface VertexAiEvalFacadeOptions {
  /** The score at or above which an invocation passes. */
  threshold: number;

  /** The name of the metric to request from the service. */
  metricName: string;

  /** The client that reaches the service. */
  client: VertexAiEvalClient;
}

/** Reads the mean score of the first summary metric, when there is one. */
function getScore(result: VertexEvaluationResult): number | undefined {
  const meanScore = result.summaryMetrics?.[0]?.meanScore;
  return Number.isFinite(meanScore) ? meanScore : undefined;
}

/** Returns the status of a score, which is absent when nothing was scored. */
function getEvalStatus(
  score: number | undefined,
  threshold: number,
): EvalStatus {
  if (score === undefined) {
    return EvalStatus.NOT_EVALUATED;
  }
  return score >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
}

/** Joins the text parts of a content with newlines. */
function getTextFromContent(content?: Content): string {
  return (content?.parts ?? [])
    .flatMap((part) => (part.text ? [part.text] : []))
    .join('\n');
}

/**
 * Scores invocations one at a time with a single-turn metric of the Vertex AI
 * Gen AI evaluation service.
 */
export class SingleTurnVertexAiEvalFacade implements Evaluator {
  private readonly threshold: number;
  private readonly metricName: string;
  private readonly client: VertexAiEvalClient;

  constructor(options: VertexAiEvalFacadeOptions) {
    this.threshold = options.threshold;
    this.metricName = options.metricName;
    this.client = options.client;
  }

  /**
   * @throws InputValidationError if the two lists have different lengths.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult> {
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const perInvocationResults: PerInvocationResult[] = [];
    let totalScore = 0;
    let scoredInvocations = 0;
    for (const [index, actual] of actualInvocations.entries()) {
      const expected = expectedInvocations?.[index];
      const result = await this.client.evaluate({
        dataset: {
          evalDataset: [
            {
              prompt: getTextFromContent(actual.userContent),
              reference: expected
                ? getTextFromContent(expected.finalResponse)
                : undefined,
              response: getTextFromContent(actual.finalResponse),
            },
          ],
        },
        metrics: [{name: this.metricName}],
      });

      const score = getScore(result);
      if (score !== undefined) {
        totalScore += score;
        scoredInvocations++;
      }
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation: expected,
        score,
        evalStatus: getEvalStatus(score, this.threshold),
      });
    }

    const overallScore =
      scoredInvocations > 0 ? totalScore / scoredInvocations : undefined;
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults,
    };
  }
}
