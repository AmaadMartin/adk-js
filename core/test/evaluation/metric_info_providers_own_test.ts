/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests that google/adk-python's `TestMetricInfoProviders` does not have. They
 * cover the unsupported-name error path, the descriptions and the openness of
 * the interval, none of which the ported set asserts. The ported set lives in
 * `metric_info_providers_test.ts`.
 */

import {
  FinalResponseMatchV2EvaluatorMetricInfoProvider,
  HallucinationsV1EvaluatorMetricInfoProvider,
  MultiTurnTaskSuccessV1MetricInfoProvider,
  MultiTurnToolUseQualityV1MetricInfoProvider,
  MultiTurnTrajectoryQualityV1MetricInfoProvider,
  PerTurnUserSimulatorQualityV1MetricInfoProvider,
  PrebuiltMetrics,
  ResponseEvaluatorMetricInfoProvider,
  RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider,
  RubricBasedMultiTurnTrajectoryMetricInfoProvider,
  RubricBasedToolUseV1EvaluatorMetricInfoProvider,
  SafetyEvaluatorV1MetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
  isInputValidationError,
  type MetricInfoProvider,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const ALL_PROVIDERS: MetricInfoProvider[] = [
  new TrajectoryEvaluatorMetricInfoProvider(),
  new ResponseEvaluatorMetricInfoProvider(
    PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
  ),
  new ResponseEvaluatorMetricInfoProvider(PrebuiltMetrics.RESPONSE_MATCH_SCORE),
  new SafetyEvaluatorV1MetricInfoProvider(),
  new MultiTurnTaskSuccessV1MetricInfoProvider(),
  new MultiTurnTrajectoryQualityV1MetricInfoProvider(),
  new MultiTurnToolUseQualityV1MetricInfoProvider(),
  new FinalResponseMatchV2EvaluatorMetricInfoProvider(),
  new RubricBasedFinalResponseQualityV1EvaluatorMetricInfoProvider(),
  new HallucinationsV1EvaluatorMetricInfoProvider(),
  new RubricBasedToolUseV1EvaluatorMetricInfoProvider(),
  new PerTurnUserSimulatorQualityV1MetricInfoProvider(),
  new RubricBasedMultiTurnTrajectoryMetricInfoProvider(),
];

/** Returns the error `fn` threw, and fails the test when it threw none. */
function errorFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return expect.fail('expected the call to throw, but it returned');
}

describe('ResponseEvaluatorMetricInfoProvider', () => {
  it('throws an InputValidationError naming an unsupported metric', () => {
    const provider = new ResponseEvaluatorMetricInfoProvider('not_a_metric');

    const error = errorFrom(() => provider.getMetricInfo());

    expect(isInputValidationError(error)).toBe(true);
    expect(error).toHaveProperty('message', '`not_a_metric` is not supported.');
  });

  it('throws on the empty metric name rather than describing it', () => {
    const provider = new ResponseEvaluatorMetricInfoProvider('');

    const error = errorFrom(() => provider.getMetricInfo());

    expect(isInputValidationError(error)).toBe(true);
    expect(error).toHaveProperty('message', '`` is not supported.');
  });

  it('accepts an unsupported metric name at construction time', () => {
    expect(
      () => new ResponseEvaluatorMetricInfoProvider('not_a_metric'),
    ).not.toThrow();
  });
});

describe('every metric info provider', () => {
  it('describes its metric with a distinct, non-empty description', () => {
    const descriptions = ALL_PROVIDERS.map(
      (provider) => provider.getMetricInfo().description,
    );

    for (const description of descriptions) {
      expect(description).toBeTruthy();
    }
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('returns equal values on every call, sharing no interval', () => {
    for (const provider of ALL_PROVIDERS) {
      const first = provider.getMetricInfo();
      const second = provider.getMetricInfo();

      expect(first).toEqual(second);
      expect(first.metricValueInfo.interval).not.toBe(
        second.metricValueInfo.interval,
      );
    }
  });

  it('leaves both ends of the interval closed', () => {
    for (const provider of ALL_PROVIDERS) {
      const interval = provider.getMetricInfo().metricValueInfo.interval;

      expect(interval?.openAtMin).toBeUndefined();
      expect(interval?.openAtMax).toBeUndefined();
    }
  });
});
