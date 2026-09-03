/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  defaultMetricEvaluatorRegistry,
  EvalMetric,
  EvalStatus,
  EvaluationResult,
  Evaluator,
  InputValidationError,
  Invocation,
  MetricEvaluatorRegistry,
  NotFoundError,
  PrebuiltMetrics,
  ResponseEvaluator,
  TrajectoryEvaluator,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** An evaluator that scores nothing, used to observe which factory ran. */
class MarkerEvaluator implements Evaluator {
  constructor(readonly evalMetric: EvalMetric) {}

  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    return {
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: actualInvocations.map((actualInvocation) => ({
        actualInvocation,
        evalStatus: EvalStatus.NOT_EVALUATED,
      })),
    };
  }
}

/** A second marker class, so a replacement is distinguishable. */
class OtherMarkerEvaluator extends MarkerEvaluator {}

const TRAJECTORY_METRIC: EvalMetric = {
  metricName: PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
  threshold: 1.0,
};

describe('MetricEvaluatorRegistry', () => {
  it('resolves the metrics that ship with ADK', () => {
    const trajectory =
      defaultMetricEvaluatorRegistry().getEvaluator(TRAJECTORY_METRIC);
    const responseMatch = defaultMetricEvaluatorRegistry().getEvaluator({
      metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
      threshold: 0.8,
    });

    expect(trajectory).toBeInstanceOf(TrajectoryEvaluator);
    expect(responseMatch).toBeInstanceOf(ResponseEvaluator);
  });

  it('returns a fresh evaluator on every call', () => {
    const first =
      defaultMetricEvaluatorRegistry().getEvaluator(TRAJECTORY_METRIC);
    const second =
      defaultMetricEvaluatorRegistry().getEvaluator(TRAJECTORY_METRIC);

    expect(first).not.toBe(second);
  });

  it('reports an unregistered metric as not found', () => {
    expect(() =>
      defaultMetricEvaluatorRegistry().getEvaluator({
        metricName: 'no_such_metric',
        threshold: 1.0,
      }),
    ).toThrow(new NotFoundError('no_such_metric not found in registry.'));
  });

  it('registers a factory and replaces one already registered', () => {
    const registry = new MetricEvaluatorRegistry();
    const metric: EvalMetric = {metricName: 'custom_metric', threshold: 1.0};

    registry.registerEvaluator(
      'custom_metric',
      (evalMetric) => new MarkerEvaluator(evalMetric),
    );
    const first = registry.getEvaluator(metric);

    registry.registerEvaluator(
      'custom_metric',
      (evalMetric) => new OtherMarkerEvaluator(evalMetric),
    );
    const second = registry.getEvaluator(metric);

    expect(first).toBeInstanceOf(MarkerEvaluator);
    expect(first).not.toBeInstanceOf(OtherMarkerEvaluator);
    expect(second).toBeInstanceOf(OtherMarkerEvaluator);
    expect((second as MarkerEvaluator).evalMetric).toBe(metric);
  });

  it('keeps a registration private to the registry it was made on', () => {
    const registry = new MetricEvaluatorRegistry();
    registry.registerEvaluator(
      'private_metric',
      (evalMetric) => new MarkerEvaluator(evalMetric),
    );

    expect(() =>
      new MetricEvaluatorRegistry().getEvaluator({
        metricName: 'private_metric',
        threshold: 1.0,
      }),
    ).toThrow(NotFoundError);
    expect(
      registry.getEvaluator({metricName: 'private_metric', threshold: 1.0}),
    ).toBeInstanceOf(MarkerEvaluator);
  });

  it('reports the missing eval client for response_evaluation_score', () => {
    expect(() =>
      new MetricEvaluatorRegistry().getEvaluator({
        metricName: PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
        threshold: 3.0,
      }),
    ).toThrow(InputValidationError);
  });

  it('hands out one shared default registry, distinct from a fresh one', () => {
    expect(defaultMetricEvaluatorRegistry()).toBe(
      defaultMetricEvaluatorRegistry(),
    );
    expect(defaultMetricEvaluatorRegistry()).not.toBe(
      new MetricEvaluatorRegistry(),
    );
  });
});
