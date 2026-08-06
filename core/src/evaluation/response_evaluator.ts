/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {EvalMetric, PrebuiltMetrics} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';
import {RougeEvaluator} from './final_response_match_v1.js';
import {
  PrebuiltMetric,
  SingleTurnVertexAiEvalFacade,
} from './vertex_ai_eval_facade.js';

/**
 * Options for constructing a {@link ResponseEvaluator}.
 *
 * Either `evalMetric`, or both `threshold` and `metricName`, may be supplied.
 */
export interface ResponseEvaluatorOptions {
  /** The pass/fail threshold. */
  threshold?: number;
  /** The metric name (`response_evaluation_score` or `response_match_score`). */
  metricName?: string;
  /** The metric whose threshold/name drives the evaluation. */
  evalMetric?: EvalMetric;
}

/**
 * Evaluates an agent's responses.
 *
 * Supports two metrics:
 *   1. `response_evaluation_score` — evaluates how coherent the agent's response
 *      was (value range [1, 5], higher is better). Delegated to the Vertex Gen
 *      AI Eval facade (COHERENCE).
 *   2. `response_match_score` — evaluates whether the agent's final response
 *      matches a golden/expected final response via ROUGE-1 (value range
 *      [0, 1], higher is better). Delegated to {@link RougeEvaluator}.
 */
export class ResponseEvaluator extends Evaluator {
  private readonly metricName:
    | PrebuiltMetric
    | PrebuiltMetrics.RESPONSE_MATCH_SCORE;
  private readonly threshold?: number;

  constructor({
    threshold,
    metricName,
    evalMetric,
  }: ResponseEvaluatorOptions = {}) {
    super();
    if (
      (threshold !== undefined && evalMetric !== undefined) ||
      (metricName !== undefined && evalMetric !== undefined)
    ) {
      throw new Error(
        'Either eval_metric should be specified or both threshold and' +
          ' metric_name should be specified.',
      );
    }

    let resolvedThreshold = threshold;
    let resolvedMetricName = metricName;
    if (evalMetric !== undefined) {
      resolvedThreshold = evalMetric.threshold;
      resolvedMetricName = evalMetric.metricName;
    }

    if (resolvedMetricName === PrebuiltMetrics.RESPONSE_EVALUATION_SCORE) {
      this.metricName = PrebuiltMetric.COHERENCE;
    } else if (resolvedMetricName === PrebuiltMetrics.RESPONSE_MATCH_SCORE) {
      this.metricName = PrebuiltMetrics.RESPONSE_MATCH_SCORE;
    } else {
      throw new Error(`\`${resolvedMetricName}\` is not supported.`);
    }

    this.threshold = resolvedThreshold;
  }

  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult {
    const metricName = this.metricName;
    // For response_match_score, delegate to the deterministic RougeEvaluator.
    if (metricName === PrebuiltMetrics.RESPONSE_MATCH_SCORE) {
      const rougeEvaluator = new RougeEvaluator({
        metricName,
        threshold: this.threshold,
      });
      return rougeEvaluator.evaluateInvocations(
        actualInvocations,
        expectedInvocations,
        conversationScenario,
      );
    }

    return new SingleTurnVertexAiEvalFacade({
      threshold: this.threshold,
      metricName,
      expectedInvocationsRequired: true,
    }).evaluateInvocations(
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    );
  }
}
