/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python
 * `tests/unittests/evaluation/test_custom_metric_evaluator.py` at `main`. Each
 * `it` keeps its Python test name so a reader can grep the original.
 *
 * The reference file has 6 tests and all 6 are here.
 *
 * Two adaptations. The reference patches `importlib.import_module`; `import()`
 * cannot be patched the same way, so these tests resolve a real fixture module
 * instead, which is the stronger assertion. And the reference's "malformed
 * path" is a path with no `.` separator; in JavaScript a bare specifier is
 * legal and names the `default` export, so the ported case uses a bare
 * specifier naming no installed package.
 */

import {
  CustomMetricEvaluator,
  InputValidationError,
  getMetricFunction,
  type EvalMetric,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  ASYNC_SCORE,
  SYNC_SCORE,
  syncMetric,
} from './fixtures/custom_metrics.js';

/** Absolute path of the fixture module standing in for user scoring code. */
const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/custom_metrics.ts', import.meta.url),
);

describe('custom_metric_evaluator', () => {
  it('test_get_metric_function_success', async () => {
    const func = await getMetricFunction(`${FIXTURE_PATH}#syncMetric`);

    expect(func).toBe(syncMetric);
  });

  it('test_get_metric_function_module_not_found', async () => {
    const resolving = getMetricFunction(
      `${FIXTURE_PATH}.does_not_exist.ts#syncMetric`,
    );

    await expect(resolving).rejects.toThrow(InputValidationError);
  });

  it('test_get_metric_function_function_not_found', async () => {
    const resolving = getMetricFunction(
      `${FIXTURE_PATH}#non_existent_function`,
    );

    await expect(resolving).rejects.toThrow(InputValidationError);
  });

  it('test_get_metric_function_malformed_path', async () => {
    const resolving = getMetricFunction('malformed_path');

    await expect(resolving).rejects.toThrow(InputValidationError);
  });

  it('test_custom_metric_evaluator_sync_function', async () => {
    const evalMetric: EvalMetric = {metricName: 'sync_metric'};
    const evaluator = new CustomMetricEvaluator(
      evalMetric,
      `${FIXTURE_PATH}#syncMetric`,
    );

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBe(SYNC_SCORE);
  });

  it('test_custom_metric_evaluator_async_function', async () => {
    const evalMetric: EvalMetric = {metricName: 'async_metric'};
    const evaluator = new CustomMetricEvaluator(
      evalMetric,
      `${FIXTURE_PATH}#asyncMetric`,
    );

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBe(ASYNC_SCORE);
  });
});
