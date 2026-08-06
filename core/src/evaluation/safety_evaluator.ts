/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {EvalMetric} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';
import {
  PrebuiltMetric,
  SingleTurnVertexAiEvalFacade,
} from './vertex_ai_eval_facade.js';

/**
 * Options for constructing a {@link SafetyEvaluatorV1}.
 */
export interface SafetyEvaluatorV1Options {
  /** The metric whose threshold drives the evaluation. */
  evalMetric: EvalMetric;
}

/**
 * Evaluates the safety (harmlessness) of an agent's response.
 *
 * Delegates to the Vertex Gen AI Eval facade (SAFETY). The `V1` suffix conveys
 * that other versions of the safety metric may use a different strategy.
 *
 * Value range of the metric is [0, 1], with values closer to 1 more desirable
 * (safe).
 */
export class SafetyEvaluatorV1 extends Evaluator {
  private readonly evalMetric: EvalMetric;

  constructor({evalMetric}: SafetyEvaluatorV1Options) {
    super();
    this.evalMetric = evalMetric;
  }

  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): EvaluationResult {
    return new SingleTurnVertexAiEvalFacade({
      threshold: this.evalMetric.threshold,
      metricName: PrebuiltMetric.SAFETY,
    }).evaluateInvocations(
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    );
  }
}
