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

/** The prebuilt multi-turn rubric metric this evaluator asks the service for. */
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
 * This metric differs from multi-turn task success, which only asks whether
 * the agent reached the goal. This metric asks how the agent got there, so a
 * redundant tool call or a detour lowers the score.
 *
 * The class delegates the scoring to the `MULTI_TURN_TRAJECTORY_QUALITY`
 * metric of the Vertex AI Gen AI evaluation service. Scores range over [0, 1],
 * and a score closer to 1 is more desirable. This is a reference-free metric,
 * so golden invocations are optional.
 *
 * The `V1` suffix conveys that there could be other versions of the metric,
 * and that those versions could use a different strategy.
 *
 * The service has no JavaScript SDK, so the caller supplies the transport and
 * owns authentication.
 */
export class MultiTurnTrajectoryQualityV1Evaluator implements Evaluator {
  private readonly delegate: Evaluator;

  /**
   * @throws InputValidationError if the metric carries no threshold.
   */
  constructor(options: MultiTurnTrajectoryQualityV1EvaluatorOptions) {
    this.delegate = new MultiTurnVertexAiEvalFacade({
      threshold: getMetricThreshold(options.evalMetric),
      metricName: MULTI_TURN_TRAJECTORY_QUALITY_METRIC_NAME,
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
