/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalMetric, getMetricThreshold} from './eval_metrics.js';
import {
  MultiTurnVertexAiEvalFacade,
  VertexAiEvalClient,
} from './vertex_ai_eval_facade.js';

/** The rubric metric of the evaluation service this evaluator requests. */
const MULTI_TURN_TASK_SUCCESS_METRIC_NAME = 'MULTI_TURN_TASK_SUCCESS';

/** Options for {@link MultiTurnTaskSuccessV1Evaluator}. */
export interface MultiTurnTaskSuccessV1EvaluatorOptions {
  /** The metric whose threshold this evaluator scores against. */
  evalMetric: EvalMetric;

  /** The client that reaches the Vertex AI Gen AI evaluation service. */
  evalClient: VertexAiEvalClient;
}

/**
 * Evaluates whether the agent achieved the goal or goals of a conversation.
 *
 * The class scores with the `MULTI_TURN_TASK_SUCCESS` rubric metric of the
 * Vertex AI Gen AI evaluation service, which reads every turn and judges
 * whether the user got what they came for. Scores range over [0, 1], and a
 * score closer to 1 is more desirable. The metric is reference free, so golden
 * invocations are optional.
 *
 * The `V1` suffix conveys that there could be other versions of the metric,
 * and that those versions could use a different strategy.
 *
 * The service has no JavaScript SDK, so the caller supplies the transport and
 * owns authentication.
 */
export class MultiTurnTaskSuccessV1Evaluator extends MultiTurnVertexAiEvalFacade {
  /**
   * @throws InputValidationError if the metric carries no threshold.
   */
  constructor(options: MultiTurnTaskSuccessV1EvaluatorOptions) {
    super({
      threshold: getMetricThreshold(options.evalMetric),
      metricName: MULTI_TURN_TASK_SUCCESS_METRIC_NAME,
      client: options.evalClient,
    });
  }
}
