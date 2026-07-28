/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';

import {getGoogleCloudAuthHeaders} from '../utils/google_cloud_auth.js';
import {logger} from '../utils/logger.js';
import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';

/**
 * The subset of Vertex Gen AI Eval prebuilt metrics used by the deterministic
 * evaluators' service-backed seams.
 */
export enum PrebuiltMetric {
  COHERENCE = 'coherence',
  SAFETY = 'safety',
}

/** OAuth scope required to call the Vertex AI prediction/eval endpoints. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Guidance shown when the real single-turn eval path is reached without a
 * resolvable Google Cloud project and location. The regional
 * `:evaluateInstances` URL cannot be built without both.
 */
const CREDENTIALS_ERROR_MESSAGE =
  'The single-turn Vertex AI eval metrics require Google Cloud credentials.' +
  ' Set both GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION (for example in a' +
  ' .env file, or via process.env) so the regional :evaluateInstances endpoint' +
  ' can be reached.';

/**
 * Maps each supported prebuilt metric to the metric-specific
 * `:evaluateInstances` request-input key and response-result key.
 */
const METRIC_ENDPOINT_MAP: Record<
  PrebuiltMetric,
  {inputKey: string; resultKey: string}
> = {
  [PrebuiltMetric.COHERENCE]: {
    inputKey: 'coherenceInput',
    resultKey: 'coherenceResult',
  },
  [PrebuiltMetric.SAFETY]: {
    inputKey: 'safetyInput',
    resultKey: 'safetyResult',
  },
};

/** Builds the regional Vertex AI `:evaluateInstances` REST URL. */
function evaluateInstancesUrl(project: string, location: string): string {
  return (
    `https://${location}-aiplatform.googleapis.com/v1/projects/` +
    `${project}/locations/${location}:evaluateInstances`
  );
}

/**
 * A single aggregated metric result returned by the Vertex Gen AI Eval SDK.
 */
export interface VertexAggregatedMetricResult {
  /** The mean score across the evaluated cases. */
  meanScore: number;
}

/**
 * The minimal shape of a Vertex Gen AI Eval SDK evaluation result consumed by
 * this facade (and produced by the unit-test mocks).
 */
export interface VertexEvalResult {
  /** Aggregated metric results; the first entry drives the score. */
  summaryMetrics: VertexAggregatedMetricResult[];
}

/**
 * A single eval case handed to the Vertex Gen AI Eval SDK.
 */
export interface VertexEvalCase {
  /** The user prompt for the invocation. */
  prompt: string;
  /** The reference (golden) response, if any. */
  reference?: string;
  /** The agent's actual response. */
  response: string;
}

/**
 * The dataset handed to {@link VertexAiEvalFacade.performEval}.
 */
export interface VertexEvalDataset {
  /** The eval cases to score. */
  evalCases: VertexEvalCase[];
}

/**
 * Arguments to {@link VertexAiEvalFacade.performEval}.
 */
export interface PerformEvalRequest {
  /** The dataset to evaluate. */
  dataset: VertexEvalDataset;
  /** The metrics to compute. */
  metrics: PrebuiltMetric[];
}

/**
 * Options for constructing a {@link VertexAiEvalFacade}.
 */
export interface VertexAiEvalFacadeOptions {
  /** The pass/fail threshold applied to the returned mean score. */
  threshold?: number;
  /** The prebuilt metric to compute. */
  metricName: PrebuiltMetric;
  /** Whether expected invocations are required for this metric. */
  expectedInvocationsRequired?: boolean;
}

/**
 * A facade over the documented Vertex AI `:evaluateInstances` REST method.
 *
 * `@google/genai` exposes no Gen AI Eval API, so {@link performEval} is a
 * single, mockable transport seam: it issues one authenticated pointwise
 * evaluation request per invocation and maps the metric-specific result into
 * the internal score shape the surrounding aggregation logic
 * (score/status/per-invocation) consumes. Unit tests mock either
 * {@link performEval} (to exercise aggregation) or `fetch`/auth (to exercise
 * the transport).
 */
export abstract class VertexAiEvalFacade extends Evaluator {
  protected readonly threshold?: number;
  protected readonly metricName: PrebuiltMetric;
  protected readonly expectedInvocationsRequired: boolean;
  private readonly auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});

  constructor({
    threshold,
    metricName,
    expectedInvocationsRequired = false,
  }: VertexAiEvalFacadeOptions) {
    super();
    this.threshold = threshold;
    this.metricName = metricName;
    this.expectedInvocationsRequired = expectedInvocationsRequired;
  }

  abstract evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult>;

  protected getText(content?: Content): string {
    if (content?.parts) {
      return content.parts
        .filter((part) => part.text)
        .map((part) => part.text)
        .join('\n');
    }
    return '';
  }

  protected getScore(evalResult: VertexEvalResult): number | undefined {
    const meanScore = evalResult.summaryMetrics[0]?.meanScore;
    if (typeof meanScore === 'number' && !Number.isNaN(meanScore)) {
      return meanScore;
    }
    return undefined;
  }

  protected getEvalStatus(score?: number): EvalStatus {
    if (score !== undefined) {
      return this.threshold !== undefined && score >= this.threshold
        ? EvalStatus.PASSED
        : EvalStatus.FAILED;
    }
    return EvalStatus.NOT_EVALUATED;
  }

  /**
   * Scores a single invocation against the Vertex AI `:evaluateInstances`
   * endpoint. This is the sole network entry point (a mockable seam).
   *
   * @throws {Error} If the project/location cannot be resolved, if the auth
   *     credentials cannot be refreshed, or if the request returns a non-2xx
   *     status. A missing or non-finite score is not an error: it maps to "no
   *     score" so the caller records `NOT_EVALUATED`.
   */
  async performEval(request: PerformEvalRequest): Promise<VertexEvalResult> {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION;
    if (!project || !location) {
      throw new Error(CREDENTIALS_ERROR_MESSAGE);
    }

    const metric = request.metrics[0];
    const {inputKey, resultKey} = METRIC_ENDPOINT_MAP[metric];
    const evalCase = request.dataset.evalCases[0];
    const url = evaluateInstancesUrl(project, location);
    const body = JSON.stringify({
      [inputKey]: {
        metricSpec: {},
        instance: {prediction: evalCase.response},
      },
    });

    const headers = await getGoogleCloudAuthHeaders(this.auth, url);
    logger.debug(`Evaluating ${metric} against ${url}`);
    const res = await fetch(url, {method: 'POST', headers, body});
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `:evaluateInstances request failed with status ${res.status}: ${text}`,
      );
    }

    const json = (await res.json()) as Record<
      string,
      {score?: number | null} | undefined
    >;
    const score = json[resultKey]?.score;
    if (typeof score === 'number' && Number.isFinite(score)) {
      return {summaryMetrics: [{meanScore: score}]};
    }
    return {summaryMetrics: []};
  }
}

/**
 * A facade for single-turn metrics exposed in the Vertex Gen AI Eval SDK.
 */
export class SingleTurnVertexAiEvalFacade extends VertexAiEvalFacade {
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    if (this.expectedInvocationsRequired && expectedInvocations === undefined) {
      throw new Error('expected_invocations is needed by this metric.');
    }
    validateInvocationLengths(actualInvocations, expectedInvocations);
    void conversationScenario; // not supported for per-invocation evaluation.

    // If expected invocations are not required and not supplied, pair each
    // actual invocation with `undefined`.
    const expected =
      expectedInvocations ?? actualInvocations.map(() => undefined);

    let totalScore = 0.0;
    let numInvocations = 0;
    const perInvocationResults: PerInvocationResult[] = [];
    for (let i = 0; i < actualInvocations.length; i++) {
      const actual = actualInvocations[i];
      const expectedInvocation = expected[i];
      const dataset: VertexEvalDataset = {
        evalCases: [
          {
            prompt: this.getText(actual.userContent),
            reference: expectedInvocation
              ? this.getText(expectedInvocation.finalResponse)
              : undefined,
            response: this.getText(actual.finalResponse),
          },
        ],
      };
      const evalCaseResult = await this.performEval({
        dataset,
        metrics: [this.metricName],
      });
      const score = this.getScore(evalCaseResult);
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation,
        score,
        evalStatus: this.getEvalStatus(score),
      });

      if (score !== undefined) {
        totalScore += score;
        numInvocations++;
      }
    }

    if (perInvocationResults.length > 0) {
      const overallScore =
        numInvocations > 0 ? totalScore / numInvocations : undefined;
      return {
        overallScore,
        overallEvalStatus: this.getEvalStatus(overallScore),
        perInvocationResults,
      };
    }

    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    };
  }
}
