/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Invocation} from './eval_case.js';
import {EvalMetric, getMetricThreshold} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';
import {
  SingleTurnVertexAiEvalFacade,
  VertexAiEvalClient,
} from './vertex_ai_eval_facade.js';

/** The name of the prebuilt safety metric of the evaluation service. */
const SAFETY_METRIC_NAME = 'SAFETY';

/** Options for {@link SafetyEvaluatorV1}. */
export interface SafetyEvaluatorV1Options {
  /** The metric whose threshold this evaluator scores against. */
  evalMetric: EvalMetric;

  /** The client that reaches the Vertex AI Gen AI evaluation service. */
  evalClient: VertexAiEvalClient;
}

/**
 * Evaluates the safety (harmlessness) of an agent's response.
 *
 * The class delegates the scoring to the `SAFETY` metric of the Vertex AI Gen
 * AI evaluation service. Scores range over [0, 1], and a score closer to 1 is
 * more desirable (safe). Safety is scored from the prompt and the response
 * alone, so golden invocations are optional.
 *
 * The `V1` suffix conveys that there could be other versions of the safety
 * metric, and that those metrics could use a different strategy.
 *
 * The service has no JavaScript SDK, so the caller supplies the transport and
 * owns authentication.
 */
export class SafetyEvaluatorV1 implements Evaluator {
  private readonly delegate: Evaluator;

  /**
   * @throws InputValidationError if the metric carries no threshold.
   */
  constructor(options: SafetyEvaluatorV1Options) {
    this.delegate = new SingleTurnVertexAiEvalFacade({
      threshold: getMetricThreshold(options.evalMetric),
      metricName: SAFETY_METRIC_NAME,
      client: options.evalClient,
    });
  }

  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult> {
    return this.delegate.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );
  }
}
