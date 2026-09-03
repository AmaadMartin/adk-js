/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  getMetricThreshold,
  InputValidationError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('judge model defaults', () => {
  // The values adk-python defaults to. A judge run crosses the boundary, so
  // the two SDKs score with the same model and the same number of samples.
  it('matches the adk-python defaults', () => {
    expect(DEFAULT_JUDGE_MODEL).toBe('gemini-2.5-flash');
    expect(DEFAULT_JUDGE_NUM_SAMPLES).toBe(5);
    expect(DEFAULT_JUDGE_PARALLELISM_LIMIT).toBe(1);
  });
});

describe('getMetricThreshold', () => {
  it('prefers the criterion threshold over the metric one', () => {
    expect(
      getMetricThreshold({
        metricName: 'final_response_match_v2',
        threshold: 0.8,
        criterion: {threshold: 0.5},
      }),
    ).toBe(0.5);
  });

  it('falls back to the deprecated metric threshold', () => {
    expect(
      getMetricThreshold({
        metricName: 'final_response_match_v2',
        threshold: 0.8,
      }),
    ).toBe(0.8);
  });

  it('rejects a metric that carries no threshold at all', () => {
    expect(() =>
      getMetricThreshold({metricName: 'final_response_match_v2'}),
    ).toThrow(InputValidationError);
  });
});
