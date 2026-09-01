/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {ConversationScenario, Invocation} from './eval_case.js';
import {
  emptyEvaluationResult,
  EvaluationResult,
  Evaluator,
  getEvalStatus,
  getTextFromContent,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';

/** A metric that the Vertex AI Gen AI evaluation service provides. */
export enum VertexPrebuiltMetric {
  COHERENCE = 'COHERENCE',
}

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
 * The service has no JavaScript SDK, so the caller supplies the transport.
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

  /**
   * The client that reaches the service. When it is absent, the credentials
   * in the environment are validated and every evaluation call then reports
   * that no client is available.
   */
  client?: VertexAiEvalClient;
}

const ERROR_MESSAGE_SUFFIX = `
You should specify both project id and location. This metric uses Vertex Gen AI
Eval SDK, and it requires google cloud credentials.

If using an .env file add the values there, or explicitly set in the code using
the template below:

process.env.GOOGLE_CLOUD_LOCATION = <LOCATION>
process.env.GOOGLE_CLOUD_PROJECT = <PROJECT ID>
`;

const NO_CLIENT_MESSAGE =
  'The Vertex AI Gen AI evaluation service has no JavaScript SDK. Supply a ' +
  'VertexAiEvalClient that calls the service to use this metric.';

/**
 * Validates the credentials in the environment and returns a client that
 * reports the missing transport when it is called.
 *
 * @throws InputValidationError if the environment carries neither an API key
 *     nor a complete project and location pair.
 */
function createUnavailableClient(): VertexAiEvalClient {
  const projectId = process.env?.['GOOGLE_CLOUD_PROJECT'];
  const location = process.env?.['GOOGLE_CLOUD_LOCATION'];
  const apiKey = process.env?.['GOOGLE_API_KEY'];

  if (!apiKey) {
    if (!projectId && !location) {
      throw new InputValidationError(
        'Either API Key or Google cloud Project id and location should be' +
          ' specified.',
      );
    }
    if (!projectId) {
      throw new InputValidationError(
        'Missing project id.' + ERROR_MESSAGE_SUFFIX,
      );
    }
    if (!location) {
      throw new InputValidationError(
        'Missing location.' + ERROR_MESSAGE_SUFFIX,
      );
    }
  }

  return {
    evaluate: () => Promise.reject(new Error(NO_CLIENT_MESSAGE)),
  };
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

  /**
   * @throws InputValidationError if no client is given and the environment
   *     carries no usable credentials.
   */
  constructor(options: VertexAiEvalFacadeOptions) {
    super();
    this.threshold = options.threshold;
    this.metricName = options.metricName;
    this.expectedInvocationsRequired =
      options.expectedInvocationsRequired ?? false;
    this.client = options.client ?? createUnavailableClient();
  }

  /**
   * @throws InputValidationError if the metric needs golden invocations and
   *     none are given, or if the two lists have different lengths.
   */
  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    _conversationScenario?: ConversationScenario,
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
