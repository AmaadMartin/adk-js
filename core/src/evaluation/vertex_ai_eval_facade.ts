/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

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
 * A minimal facade over the Vertex Gen AI Eval SDK.
 *
 * `@google/genai` exposes no Gen AI Eval API, so {@link performEval} is a
 * mockable seam that throws by default. Unit tests mock it; the surrounding
 * aggregation logic (score/status/per-invocation) is fully exercised via the
 * mock. Wiring in the real SDK is a queued follow-up.
 */
export abstract class VertexAiEvalFacade extends Evaluator {
  protected readonly threshold?: number;
  protected readonly metricName: PrebuiltMetric;
  protected readonly expectedInvocationsRequired: boolean;

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
  ): EvaluationResult;

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
   * Calls the external Vertex Gen AI Eval service. This is a mockable seam;
   * the real SDK is not available in adk-js, so it throws by default.
   */
  performEval(request: PerformEvalRequest): VertexEvalResult {
    void request;
    throw new Error(
      'Vertex Gen AI Eval SDK is not available in adk-js; this metric requires' +
        ' a service-backed implementation. See the queued follow-up to wire in' +
        ' the real Vertex Gen AI Eval SDK.',
    );
  }
}

/**
 * A facade for single-turn metrics exposed in the Vertex Gen AI Eval SDK.
 */
export class SingleTurnVertexAiEvalFacade extends VertexAiEvalFacade {
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult {
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
      const evalCaseResult = this.performEval({
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
