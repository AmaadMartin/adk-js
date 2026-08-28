/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {PrebuiltMetrics} from './eval_metrics.js';
import {
  EvaluationResult,
  Evaluator,
  EvaluatorConstructorOptions,
} from './evaluator.js';
import {RougeEvaluator} from './final_response_match_v1.js';
import {
  PrebuiltMetric,
  SingleTurnVertexAiEvalFacade,
} from './vertex_ai_eval_facade.js';

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

  constructor({evalMetric}: EvaluatorConstructorOptions) {
    super();
    if (evalMetric.metricName === PrebuiltMetrics.RESPONSE_EVALUATION_SCORE) {
      this.metricName = PrebuiltMetric.COHERENCE;
    } else if (evalMetric.metricName === PrebuiltMetrics.RESPONSE_MATCH_SCORE) {
      this.metricName = PrebuiltMetrics.RESPONSE_MATCH_SCORE;
    } else {
      throw new Error(`\`${evalMetric.metricName}\` is not supported.`);
    }

    this.threshold = evalMetric.threshold;
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
