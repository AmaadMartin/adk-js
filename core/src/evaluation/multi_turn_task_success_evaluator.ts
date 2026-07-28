/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation} from './eval_case.js';
import {EvalMetric} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';
import {
  MultiTurnVertexAiEvalFacade,
  RubricMetric,
} from './vertex_ai_eval_facade.js';

/**
 * Evaluates whether the agent achieved the goal(s) of the conversation.
 *
 * The metric takes into account all the turns of the multi-turn conversation.
 * It delegates to the Vertex Gen AI Eval SDK via {@link
 * MultiTurnVertexAiEvalFacade}; the `V1` suffix conveys that other versions of
 * the metric may exist and use a different strategy.
 *
 * Value range of the metric is [0, 1], with values closer to 1 being more
 * desirable.
 */
export class MultiTurnTaskSuccessV1Evaluator extends Evaluator {
  constructor(private readonly evalMetric: EvalMetric) {
    super();
  }

  override evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: unknown,
  ): EvaluationResult {
    return new MultiTurnVertexAiEvalFacade(
      this.evalMetric.threshold!,
      RubricMetric.MULTI_TURN_TASK_SUCCESS,
    ).evaluateInvocations(
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    );
  }
}
