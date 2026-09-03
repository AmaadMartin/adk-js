/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getMetricThreshold,
  normalizeToolTrajectoryMatchType,
  parseToolTrajectoryCriterion,
  ToolTrajectoryMatchType,
} from '../../src/evaluation/eval_metrics.js';

const MATCH_TYPE_SPELLINGS: Array<[string, ToolTrajectoryMatchType]> = [
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
];

describe('eval_metrics', () => {
  describe('normalizeToolTrajectoryMatchType', () => {
    it.each(MATCH_TYPE_SPELLINGS)('resolves %s', (spelling, expected) => {
      expect(normalizeToolTrajectoryMatchType(spelling)).toBe(expected);
    });

    it('reads an absent value as EXACT', () => {
      expect(normalizeToolTrajectoryMatchType(undefined)).toBe(
        ToolTrajectoryMatchType.EXACT,
      );
    });

    it('resolves nothing for an unknown spelling', () => {
      expect(normalizeToolTrajectoryMatchType('random string')).toBeUndefined();
    });

    it('resolves nothing for a value that is not a string', () => {
      expect(normalizeToolTrajectoryMatchType(1)).toBeUndefined();
    });
  });

  describe('getMetricThreshold', () => {
    it('prefers the criterion threshold', () => {
      const threshold = getMetricThreshold({
        metricName: 'tool_trajectory_avg_score',
        threshold: 0.2,
        criterion: {threshold: 0.8},
      });

      expect(threshold).toBe(0.8);
    });

    it('falls back to the metric threshold', () => {
      const threshold = getMetricThreshold({
        metricName: 'tool_trajectory_avg_score',
        threshold: 0.2,
      });

      expect(threshold).toBe(0.2);
    });

    it('rejects a metric that names no threshold', () => {
      expect(() =>
        getMetricThreshold({metricName: 'tool_trajectory_avg_score'}),
      ).toThrow(
        new InputValidationError(
          "Evaluation metric 'tool_trajectory_avg_score' requires a threshold.",
        ),
      );
    });
  });

  describe('parseToolTrajectoryCriterion', () => {
    it('applies the match type and ignoreArgs defaults', () => {
      expect(parseToolTrajectoryCriterion({threshold: 0.5})).toEqual({
        threshold: 0.5,
        matchType: ToolTrajectoryMatchType.EXACT,
        ignoreArgs: false,
      });
    });

    it('resolves a string match type', () => {
      const criterion = parseToolTrajectoryCriterion({
        threshold: 0.5,
        matchType: 'any order',
      });

      expect(criterion.matchType).toBe(ToolTrajectoryMatchType.ANY_ORDER);
    });

    it('accepts the snake_case key spellings', () => {
      const criterion = parseToolTrajectoryCriterion({
        threshold: 0.5,
        match_type: 'IN_ORDER',
        ignore_args: true,
      });

      expect(criterion.matchType).toBe(ToolTrajectoryMatchType.IN_ORDER);
      expect(criterion.ignoreArgs).toBe(true);
    });

    it('prefers the camelCase key when a payload carries both spellings', () => {
      const criterion = parseToolTrajectoryCriterion({
        threshold: 0.5,
        matchType: 'ANY_ORDER',
        match_type: 'IN_ORDER',
        ignoreArgs: false,
        ignore_args: true,
      });

      expect(criterion.matchType).toBe(ToolTrajectoryMatchType.ANY_ORDER);
      expect(criterion.ignoreArgs).toBe(false);
    });

    it('keeps a key the criterion does not name', () => {
      const criterion = parseToolTrajectoryCriterion({
        threshold: 0.5,
        judgeModelOptions: {model: 'gemini-2.5-flash'},
      });

      expect(criterion).toMatchObject({
        judgeModelOptions: {model: 'gemini-2.5-flash'},
      });
    });

    it.each([['not an object'], [null], [42], [[{threshold: 0.5}]]])(
      'rejects the payload %s, which is not a record',
      (raw) => {
        expect(() => parseToolTrajectoryCriterion(raw)).toThrow(
          new InputValidationError(
            'A tool trajectory criterion must be an object.',
          ),
        );
      },
    );

    it.each([[{}], [{threshold: 'high'}], [{threshold: Number.NaN}]])(
      'rejects the payload %o, which carries no numeric threshold',
      (raw) => {
        expect(() => parseToolTrajectoryCriterion(raw)).toThrow(
          new InputValidationError(
            'A tool trajectory criterion requires a numeric `threshold`.',
          ),
        );
      },
    );

    it('rejects a match type it cannot resolve', () => {
      expect(() =>
        parseToolTrajectoryCriterion({
          threshold: 0.5,
          matchType: 'random string',
        }),
      ).toThrow(
        new InputValidationError(
          'A tool trajectory criterion accepts as `matchType` one of EXACT,' +
            ' IN_ORDER, ANY_ORDER.',
        ),
      );
    });

    it('rejects an ignoreArgs that is not a boolean', () => {
      expect(() =>
        parseToolTrajectoryCriterion({threshold: 0.5, ignoreArgs: 'yes'}),
      ).toThrow(
        new InputValidationError(
          'A tool trajectory criterion requires `ignoreArgs` to be a boolean.',
        ),
      );
    });
  });
});
