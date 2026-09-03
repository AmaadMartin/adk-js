/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getMetricThreshold, InputValidationError} from '@google/adk';
import {describe, expect, it} from 'vitest';

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
