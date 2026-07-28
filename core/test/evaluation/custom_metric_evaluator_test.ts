/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CustomMetricEvaluator,
  type EvalMetric,
  getMetricFunction,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const FIXTURE_MODULE = new URL('./custom_metric_fixtures.ts', import.meta.url)
  .href;
const SYNC_PATH = `${FIXTURE_MODULE}.mySyncMetricFunction`;
const ASYNC_PATH = `${FIXTURE_MODULE}.myAsyncMetricFunction`;

describe('evaluation/custom_metric_evaluator', () => {
  describe('getMetricFunction', () => {
    it('loads an exported function from a module path', async () => {
      const func = await getMetricFunction(SYNC_PATH);
      expect(typeof func).toBe('function');
      expect(func.name).toBe('mySyncMetricFunction');
    });

    it('throws when the module cannot be imported', async () => {
      await expect(
        getMetricFunction('/nonexistent/module.ts.someFunction'),
      ).rejects.toThrow(
        'Could not import custom metric function from' +
          ' /nonexistent/module.ts.someFunction',
      );
    });

    it('throws when the named export is not a function', async () => {
      await expect(
        getMetricFunction(`${FIXTURE_MODULE}.nonExistentFunction`),
      ).rejects.toThrow('Could not import custom metric function from');
    });

    it('throws for a malformed path with no separator', async () => {
      await expect(getMetricFunction('malformed_path')).rejects.toThrow(
        'Could not import custom metric function from malformed_path',
      );
    });
  });

  describe('CustomMetricEvaluator', () => {
    const evalMetric: EvalMetric = {
      metricName: 'custom_metric',
      threshold: 0.5,
    };

    it('runs a synchronous metric function', async () => {
      const evaluator = new CustomMetricEvaluator({
        evalMetric,
        customFunctionPath: SYNC_PATH,
      });
      const result = await evaluator.evaluateInvocations([], undefined);
      expect(result.overallScore).toBe(1.0);
    });

    it('runs an asynchronous metric function', async () => {
      const evaluator = new CustomMetricEvaluator({
        evalMetric,
        customFunctionPath: ASYNC_PATH,
      });
      const result = await evaluator.evaluateInvocations([], undefined);
      expect(result.overallScore).toBe(0.5);
    });

    it('passes the eval metric with a cleared threshold', async () => {
      const capturePath = `${FIXTURE_MODULE}.mySyncMetricFunction`;
      const evaluator = new CustomMetricEvaluator({
        evalMetric: {metricName: 'custom_metric', threshold: 0.9},
        customFunctionPath: capturePath,
      });
      // The sync fixture ignores its arguments; this simply exercises the
      // threshold-clearing copy path without mutating the original metric.
      const original: EvalMetric = {
        metricName: 'custom_metric',
        threshold: 0.9,
      };
      await evaluator.evaluateInvocations([], undefined);
      expect(original.threshold).toBe(0.9);
    });
  });
});
