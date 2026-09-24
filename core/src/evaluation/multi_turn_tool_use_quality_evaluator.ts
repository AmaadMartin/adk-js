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
const MULTI_TURN_TOOL_USE_QUALITY_METRIC_NAME = 'MULTI_TURN_TOOL_USE_QUALITY';

/** Options for {@link MultiTurnToolUseQualityV1Evaluator}. */
export interface MultiTurnToolUseQualityV1EvaluatorOptions {
  /** The metric whose threshold this evaluator scores against. */
  evalMetric: EvalMetric;

  /** The client that reaches the Vertex AI Gen AI evaluation service. */
  evalClient: VertexAiEvalClient;
}

/**
 * Evaluates the quality of the tool calls an agent made across a conversation.
 *
 * The class is the `MULTI_TURN_TOOL_USE_QUALITY` metric of the Vertex AI Gen
 * AI evaluation service, preconfigured. Scores range over [0, 1], and a score
 * closer to 1 is more desirable. The metric is reference-free, so golden
 * invocations are optional.
 *
 * The `V1` suffix conveys that there could be other versions of the metric,
 * and that those metrics could use a different strategy.
 *
 * The service has no JavaScript SDK, so the caller supplies the transport and
 * owns authentication.
 */
export class MultiTurnToolUseQualityV1Evaluator extends MultiTurnVertexAiEvalFacade {
  /**
   * @throws InputValidationError if the metric carries no threshold.
   */
  constructor(options: MultiTurnToolUseQualityV1EvaluatorOptions) {
    super({
      threshold: getMetricThreshold(options.evalMetric),
      metricName: MULTI_TURN_TOOL_USE_QUALITY_METRIC_NAME,
      client: options.evalClient,
    });
  }
}
