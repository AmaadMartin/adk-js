/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CustomMetricEvaluator,
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
  registerCustomMetricsFromConfig,
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

describe('MetricEvaluatorRegistry.fork', () => {
  it('carries every registration the source registry holds', () => {
    const source = new MetricEvaluatorRegistry();
    source.registerEvaluator(
      'inherited_metric',
      (evalMetric) => new MarkerEvaluator(evalMetric),
    );

    const forked = source.fork();

    expect(
      forked.getEvaluator({metricName: 'inherited_metric', threshold: 1.0}),
    ).toBeInstanceOf(MarkerEvaluator);
    expect(forked.getEvaluator(TRAJECTORY_METRIC)).toBeInstanceOf(
      TrajectoryEvaluator,
    );
  });

  it('hides a later registration on the fork from the source', () => {
    const source = new MetricEvaluatorRegistry();
    const forked = source.fork();

    forked.registerEvaluator(
      'fork_only_metric',
      (evalMetric) => new MarkerEvaluator(evalMetric),
    );

    expect(() =>
      source.getEvaluator({metricName: 'fork_only_metric', threshold: 1.0}),
    ).toThrow(NotFoundError);
  });

  it('hides a later registration on the source from the fork', () => {
    const source = new MetricEvaluatorRegistry();
    const forked = source.fork();

    source.registerEvaluator(
      'source_only_metric',
      (evalMetric) => new MarkerEvaluator(evalMetric),
    );

    expect(() =>
      forked.getEvaluator({metricName: 'source_only_metric', threshold: 1.0}),
    ).toThrow(NotFoundError);
  });

  it('replaces a standard metric the source overrode', () => {
    const source = new MetricEvaluatorRegistry();
    source.registerEvaluator(
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
      (evalMetric) => new MarkerEvaluator(evalMetric),
    );

    expect(source.fork().getEvaluator(TRAJECTORY_METRIC)).toBeInstanceOf(
      MarkerEvaluator,
    );
  });
});

describe('registerCustomMetricsFromConfig', () => {
  it('registers an evaluator for every custom metric of the config', () => {
    const registry = registerCustomMetricsFromConfig(
      {
        criteria: {},
        customMetrics: {
          first_metric: {codeConfig: {name: './metrics.js#first'}},
          second_metric: {codeConfig: {name: './metrics.js#second'}},
        },
      },
      new MetricEvaluatorRegistry(),
    );

    expect(
      registry.getEvaluator({metricName: 'first_metric', threshold: 0.5}),
    ).toBeInstanceOf(CustomMetricEvaluator);
    expect(
      registry.getEvaluator({metricName: 'second_metric', threshold: 0.5}),
    ).toBeInstanceOf(CustomMetricEvaluator);
  });

  it('returns the registry untouched when the config declares none', () => {
    const registry = new MetricEvaluatorRegistry();

    expect(registerCustomMetricsFromConfig({criteria: {}}, registry)).toBe(
      registry,
    );
    expect(registry.getEvaluator(TRAJECTORY_METRIC)).toBeInstanceOf(
      TrajectoryEvaluator,
    );
  });
});

describe('MetricEvaluatorRegistry.getRegisteredMetrics', () => {
  it('describes every standard metric the registry seeds', () => {
    const registry = new MetricEvaluatorRegistry();

    expect(
      registry
        .getRegisteredMetrics()
        .map((info) => info.metricName)
        .sort(),
    ).toEqual([
      PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
      PrebuiltMetrics.RESPONSE_MATCH_SCORE,
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
    ]);
  });

  it('carries the value range each metric is scored on', () => {
    const registry = new MetricEvaluatorRegistry();

    const info = registry
      .getRegisteredMetrics()
      .find(
        (candidate) =>
          candidate.metricName === PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
      );

    expect(info?.metricValueInfo.interval).toMatchObject({
      minValue: 1.0,
      maxValue: 5.0,
    });
  });

  it('omits a metric registered without a description of itself', () => {
    const registry = new MetricEvaluatorRegistry();

    registry.registerEvaluator(
      'undescribed_metric',
      (evalMetric) => new MarkerEvaluator(evalMetric),
    );

    expect(
      registry.getRegisteredMetrics().map((info) => info.metricName),
    ).not.toContain('undescribed_metric');
  });

  it('describes a metric registered with a description of itself', () => {
    const registry = new MetricEvaluatorRegistry();
    const metricInfo = {
      metricName: 'described_metric',
      metricValueInfo: {interval: {minValue: 0, maxValue: 1}},
    };

    registry.registerEvaluator(
      'described_metric',
      (evalMetric) => new MarkerEvaluator(evalMetric),
      {getMetricInfo: () => metricInfo},
    );

    expect(registry.getRegisteredMetrics()).toContain(metricInfo);
  });

  it('carries the descriptions into a fork', () => {
    const forked = new MetricEvaluatorRegistry().fork();

    expect(forked.getRegisteredMetrics()).toHaveLength(3);
  });

  it('describes the same metrics on the default registry', () => {
    expect(
      defaultMetricEvaluatorRegistry().getRegisteredMetrics(),
    ).toHaveLength(3);
  });
});
