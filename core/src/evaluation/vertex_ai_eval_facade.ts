/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {Invocation} from './eval_case.js';
import {
  emptyEvaluationResult,
  EvaluationResult,
  Evaluator,
  getEvalStatus,
  getTextFromContent,
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

  /** Whether the metric needs golden invocations. Defaults to false. */
  expectedInvocationsRequired?: boolean;

  /** The client that reaches the service. */
  client: VertexAiEvalClient;
}

/** Reads the mean score of the first summary metric, when there is one. */
function getScore(result: VertexEvaluationResult): number | undefined {
  const meanScore = result.summaryMetrics?.[0]?.meanScore;
  return Number.isFinite(meanScore) ? meanScore : undefined;
}

/**
 * Scores invocations one at a time with a single-turn metric of the Vertex AI
 * Gen AI evaluation service.
 */
export class SingleTurnVertexAiEvalFacade extends Evaluator {
  private readonly threshold: number;
  private readonly metricName: string;
  private readonly expectedInvocationsRequired: boolean;
  private readonly client: VertexAiEvalClient;

  constructor(options: VertexAiEvalFacadeOptions) {
    super();
    this.threshold = options.threshold;
    this.metricName = options.metricName;
    this.expectedInvocationsRequired =
      options.expectedInvocationsRequired ?? false;
    this.client = options.client;
  }

  /**
   * @throws InputValidationError if the metric needs golden invocations and
   *     none are given, or if the two lists have different lengths.
   */
  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult> {
    if (this.expectedInvocationsRequired && expectedInvocations === undefined) {
      throw new InputValidationError(
        'expectedInvocations is needed by this metric.',
      );
    }
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

    if (perInvocationResults.length === 0) {
      return emptyEvaluationResult();
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
