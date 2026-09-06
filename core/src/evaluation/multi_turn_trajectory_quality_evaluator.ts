/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation} from './eval_case.js';
import {EvalMetric, getMetricThreshold} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';
import {
  MultiTurnVertexAiEvalFacade,
  VertexAiEvalClient,
} from './vertex_ai_eval_facade.js';

/** The rubric metric of the evaluation service this evaluator requests. */
const MULTI_TURN_TRAJECTORY_QUALITY_METRIC_NAME =
  'MULTI_TURN_TRAJECTORY_QUALITY';

/** Options for {@link MultiTurnTrajectoryQualityV1Evaluator}. */
export interface MultiTurnTrajectoryQualityV1EvaluatorOptions {
  /** The metric whose threshold this evaluator scores against. */
  evalMetric: EvalMetric;

  /** The client that reaches the Vertex AI Gen AI evaluation service. */
  evalClient: VertexAiEvalClient;
}

/**
 * Evaluates the path an agent took across a whole conversation.
 *
 * The metric differs from multi-turn task success, which asks only whether the
 * agent reached the goal. This one asks how the agent reached it, so a detour,
 * a redundant tool call, or a wrong ordering lowers the score even when the
 * final answer is right.
 *
 * The class is the `MULTI_TURN_TRAJECTORY_QUALITY` metric of the Vertex AI Gen
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
export class MultiTurnTrajectoryQualityV1Evaluator implements Evaluator {
  private readonly facade: MultiTurnVertexAiEvalFacade;

  /**
   * @throws {InputValidationError} When the metric carries no threshold.
   */
  constructor(options: MultiTurnTrajectoryQualityV1EvaluatorOptions) {
    this.facade = new MultiTurnVertexAiEvalFacade({
      threshold: getMetricThreshold(options.evalMetric),
      metricName: MULTI_TURN_TRAJECTORY_QUALITY_METRIC_NAME,
      client: options.evalClient,
    });
  }

  /**
   * @throws {InputValidationError} When the two invocation lists have
   *   different lengths.
   */
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult> {
    return this.facade.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );
  }
}
