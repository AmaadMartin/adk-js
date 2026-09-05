/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation} from './eval_case.js';
import {EvalMetric, getMetricThreshold} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';
import {
  MultiTurnVertexAiEvalFacade,
  VertexAiEvalClient,
} from './vertex_ai_eval_facade.js';

/** The name of the multi-turn task-success rubric metric of the service. */
const MULTI_TURN_TASK_SUCCESS_METRIC_NAME = 'MULTI_TURN_TASK_SUCCESS';

/** Options for {@link MultiTurnTaskSuccessV1Evaluator}. */
export interface MultiTurnTaskSuccessV1EvaluatorOptions {
  /** The metric whose threshold this evaluator scores against. */
  evalMetric: EvalMetric;

  /** The client that reaches the Vertex AI Gen AI evaluation service. */
  evalClient: VertexAiEvalClient;
}

/**
 * Evaluates whether the agent achieved the goals of a whole conversation.
 *
 * The class delegates the scoring to the `MULTI_TURN_TASK_SUCCESS` rubric
 * metric of the Vertex AI Gen AI evaluation service, which reads every turn
 * and returns one score for the conversation. Scores range over [0, 1], and a
 * score closer to 1 is more desirable. Only the last turn carries the score;
 * the leading turns come back `NOT_EVALUATED`.
 *
 * The `V1` suffix conveys that there could be other versions of the metric,
 * and that those versions could score task success differently.
 *
 * The service has no JavaScript SDK, so the caller supplies the transport and
 * owns authentication. Reaching the service needs a Google Cloud project:
 * build the client's configuration with `resolveVertexAiEvalClientConfig`,
 * which reads `GOOGLE_API_KEY`, or `GOOGLE_CLOUD_PROJECT` and
 * `GOOGLE_CLOUD_LOCATION`.
 */
export class MultiTurnTaskSuccessV1Evaluator implements Evaluator {
  private readonly delegate: Evaluator;

  /**
   * @throws InputValidationError if the metric carries no threshold.
   */
  constructor(options: MultiTurnTaskSuccessV1EvaluatorOptions) {
    this.delegate = new MultiTurnVertexAiEvalFacade({
      threshold: getMetricThreshold(options.evalMetric),
      metricName: MULTI_TURN_TASK_SUCCESS_METRIC_NAME,
      client: options.evalClient,
    });
  }

  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    return this.delegate.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    );
  }
}
