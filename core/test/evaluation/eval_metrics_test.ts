/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  InputValidationError,
  PrebuiltMetrics,
  ToolTrajectoryMatchType,
  getMetricThreshold,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {normalizeToolTrajectoryMatchType} from '../../src/evaluation/eval_metrics.js';

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

const METRIC_NAME = 'tool_trajectory_avg_score';

describe('eval_metrics', () => {
  describe('getMetricThreshold', () => {
    it('prefers the criterion threshold over the metric threshold', () => {
      expect(
        getMetricThreshold({
          metricName: METRIC_NAME,
          threshold: 0.2,
          criterion: {threshold: 0.8},
        }),
      ).toBe(0.8);
    });

    it('falls back to the metric threshold when there is no criterion', () => {
      expect(
        getMetricThreshold({metricName: METRIC_NAME, threshold: 0.4}),
      ).toBe(0.4);
    });

    it('honours a metric threshold of zero', () => {
      expect(getMetricThreshold({metricName: METRIC_NAME, threshold: 0})).toBe(
        0,
      );
    });

    it('rejects a metric that carries no threshold at all', () => {
      expect(() => getMetricThreshold({metricName: METRIC_NAME})).toThrowError(
        new InputValidationError(
          `Evaluation metric '${METRIC_NAME}' requires a threshold.`,
        ),
      );
    });
  });

  describe('normalizeToolTrajectoryMatchType', () => {
    it('defaults to EXACT when no match type is given', () => {
      expect(normalizeToolTrajectoryMatchType(undefined)).toBe(
        ToolTrajectoryMatchType.EXACT,
      );
    });

    it.each([
      ['exact', ToolTrajectoryMatchType.EXACT],
      ['EXACT', ToolTrajectoryMatchType.EXACT],
      [' exact ', ToolTrajectoryMatchType.EXACT],
      ['in order', ToolTrajectoryMatchType.IN_ORDER],
      ['IN ORDER', ToolTrajectoryMatchType.IN_ORDER],
      ['In OrDeR', ToolTrajectoryMatchType.IN_ORDER],
      ['in-order', ToolTrajectoryMatchType.IN_ORDER],
      ['IN-ORDER', ToolTrajectoryMatchType.IN_ORDER],
      ['in_order', ToolTrajectoryMatchType.IN_ORDER],
      ['any order', ToolTrajectoryMatchType.ANY_ORDER],
      ['ANY ORDER', ToolTrajectoryMatchType.ANY_ORDER],
      ['any-order', ToolTrajectoryMatchType.ANY_ORDER],
      ['ANY-ORDER', ToolTrajectoryMatchType.ANY_ORDER],
      ['any_order', ToolTrajectoryMatchType.ANY_ORDER],
    ])('normalizes %s', (spelling, expected) => {
      expect(normalizeToolTrajectoryMatchType(spelling)).toBe(expected);
    });

    it('accepts an enum member', () => {
      expect(
        normalizeToolTrajectoryMatchType(ToolTrajectoryMatchType.ANY_ORDER),
      ).toBe(ToolTrajectoryMatchType.ANY_ORDER);
    });

    it.each([['random string'], [null], [7], [{}]])(
      'reads %s as no match type',
      (value: unknown) => {
        expect(normalizeToolTrajectoryMatchType(value)).toBeUndefined();
      },
    );
  });
});
