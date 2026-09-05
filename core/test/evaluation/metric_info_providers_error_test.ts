/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests authored for adk-js, covering what the ported reference suite in
 * `metric_info_providers_test.ts` does not: the error path, the deferred
 * validation, and the exact shape of a returned `MetricInfo`.
 */

import {
  InputValidationError,
  PrebuiltMetrics,
  ResponseEvaluatorMetricInfoProvider,
  TrajectoryEvaluatorMetricInfoProvider,
  parseMetricInfo,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ResponseEvaluatorMetricInfoProvider with an unsupported name', () => {
  it('throws InputValidationError naming the metric', () => {
    const provider = new ResponseEvaluatorMetricInfoProvider('not_a_metric');

    expect(() => provider.getMetricInfo()).toThrow(InputValidationError);
    expect(() => provider.getMetricInfo()).toThrow(
      '`not_a_metric` is not supported.',
    );
  });

  it('defers the check to getMetricInfo, so the constructor succeeds', () => {
    expect(
      () => new ResponseEvaluatorMetricInfoProvider('not_a_metric'),
    ).not.toThrow();
  });
});

describe('the MetricInfo a provider returns', () => {
  it('carries the name, the description and both interval bounds', () => {
    const metricInfo = new ResponseEvaluatorMetricInfoProvider(
      PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    ).getMetricInfo();

    expect(metricInfo).toEqual({
      metricName: 'response_evaluation_score',
      description:
        "This metric evaluates how coherent agent's response was. Value" +
        ' range of this metric is [1,5], with values closer to 5 more' +
        ' desirable.',
      metricValueInfo: {
        interval: {
          minValue: 1.0,
          openAtMin: false,
          maxValue: 5.0,
          openAtMax: false,
        },
      },
    });
  });

  it('survives the eval config validator unchanged', () => {
    const metricInfo =
      new TrajectoryEvaluatorMetricInfoProvider().getMetricInfo();

    expect(parseMetricInfo(structuredClone(metricInfo))).toEqual(metricInfo);
  });

  it('is a fresh object per call, so a caller cannot poison the next', () => {
    const provider = new TrajectoryEvaluatorMetricInfoProvider();

    const first = provider.getMetricInfo();
    const second = provider.getMetricInfo();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe('parseMetricInfo on a payload a provider did not produce', () => {
  it('throws InputValidationError when metricName is missing', () => {
    expect(() => parseMetricInfo({metricValueInfo: {}})).toThrow(
      InputValidationError,
    );
  });
});
