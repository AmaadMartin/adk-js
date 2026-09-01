/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalStatus, getMetricThreshold, PrebuiltMetrics} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('getMetricThreshold', () => {
  it('prefers the criterion over the deprecated threshold field', () => {
    const threshold = getMetricThreshold({
      metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
      threshold: 0.2,
      criterion: {threshold: 0.9},
    });

    expect(threshold).toBe(0.9);
  });

  it('falls back to the threshold field', () => {
    const threshold = getMetricThreshold({
      metricName: PrebuiltMetrics.SAFETY_V1,
      threshold: 0.5,
    });

    expect(threshold).toBe(0.5);
  });

  it('rejects a metric that carries no threshold at all', () => {
    expect(() => getMetricThreshold({metricName: 'my_metric'})).toThrowError(
      "Evaluation metric 'my_metric' requires a threshold.",
    );
  });
});

describe('EvalStatus', () => {
  it('names the statuses the way the CSV output reports them', () => {
    expect(EvalStatus[EvalStatus.PASSED]).toBe('PASSED');
    expect(EvalStatus[EvalStatus.FAILED]).toBe('FAILED');
    expect(EvalStatus[EvalStatus.NOT_EVALUATED]).toBe('NOT_EVALUATED');
  });
});
