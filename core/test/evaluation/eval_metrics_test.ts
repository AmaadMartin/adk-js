/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getMetricThreshold,
  InputValidationError,
  parseToolTrajectoryMatchType,
  ToolTrajectoryMatchType,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

  describe('parseToolTrajectoryMatchType', () => {
    it('defaults to EXACT when no match type is given', () => {
      expect(parseToolTrajectoryMatchType(undefined)).toBe(
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
      expect(parseToolTrajectoryMatchType(spelling)).toBe(expected);
    });

    it('accepts an enum member', () => {
      expect(
        parseToolTrajectoryMatchType(ToolTrajectoryMatchType.ANY_ORDER),
      ).toBe(ToolTrajectoryMatchType.ANY_ORDER);
    });

    it.each([['random string'], [null], [7], [{}]])(
      'rejects %s',
      (value: unknown) => {
        expect(() => parseToolTrajectoryMatchType(value)).toThrowError(
          InputValidationError,
        );
      },
    );
  });
});
