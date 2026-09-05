/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {Invocation} from './eval_case.js';
import {
  EvalMetric,
  getMetricThreshold,
  PrebuiltMetrics,
} from './eval_metrics.js';
import {EvaluationResult, Evaluator} from './evaluator.js';
import {RougeEvaluator} from './final_response_match_v1.js';
import {
  SingleTurnVertexAiEvalFacade,
  VertexAiEvalClient,
} from './vertex_ai_eval_facade.js';

/** Options for {@link ResponseEvaluator}. */
export interface ResponseEvaluatorOptions {
  /** The score at or above which an invocation passes. */
  threshold?: number;

  /** The metric to score, given together with `threshold`. */
  metricName?: string;

  /** The metric to score, given instead of `threshold` and `metricName`. */
  evalMetric?: EvalMetric;

  /**
   * The client that reaches the Vertex AI Gen AI evaluation service.
   * `response_evaluation_score` needs it; `response_match_score` does not.
   */
  evalClient?: VertexAiEvalClient;
}

/**
 * Evaluates an agent's responses.
 *
 * This class supports two metrics.
 *
 * 1. `response_evaluation_score` scores how coherent the agent's response was.
 *    Scores range over [1, 5], and a score closer to 5 is more desirable. The
 *    Vertex AI Gen AI evaluation service produces the score, so this metric
 *    needs an `evalClient`.
 * 2. `response_match_score` scores whether the agent's final response matches
 *    a golden final response, with the ROUGE-1 metric. Scores range over
 *    [0, 1], and a score closer to 1 is more desirable.
 */
export class ResponseEvaluator extends Evaluator {
  private readonly delegate: Evaluator;

  /**
   * @throws InputValidationError if the options mix `evalMetric` with
   *     `threshold` or `metricName`, carry no threshold, name a metric this
   *     class does not support, or omit the client the metric needs.
   */
  constructor(options: ResponseEvaluatorOptions = {}) {
    super();
    let {threshold, metricName} = options;
    const {evalMetric, evalClient} = options;

    if (evalMetric && (threshold !== undefined || metricName !== undefined)) {
      throw new InputValidationError(
        'Either evalMetric should be specified or both threshold and' +
          ' metricName should be specified.',
      );
    }

    if (evalMetric) {
      threshold = getMetricThreshold(evalMetric);
      metricName = evalMetric.metricName;
    }

    if (threshold === undefined) {
      throw new InputValidationError(
        'A response evaluation threshold is required.',
      );
    }

    if (metricName === PrebuiltMetrics.RESPONSE_MATCH_SCORE) {
      this.delegate = new RougeEvaluator({metricName, threshold});
    } else if (metricName === PrebuiltMetrics.RESPONSE_EVALUATION_SCORE) {
      if (!evalClient) {
        throw new InputValidationError(
          `\`${metricName}\` requires an evalClient: the Vertex AI Gen AI` +
            ' evaluation service has no JavaScript SDK, so the caller supplies' +
            ' the transport.',
        );
      }
      this.delegate = new SingleTurnVertexAiEvalFacade({
        threshold,
        metricName: 'COHERENCE',
        expectedInvocationsRequired: true,
        client: evalClient,
      });
    } else {
      throw new InputValidationError(`\`${metricName}\` is not supported.`);
    }
  }

  override evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
  ): Promise<EvaluationResult> {
    return this.delegate.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
    );
  }
}
