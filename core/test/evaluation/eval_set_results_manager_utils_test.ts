/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCaseResult,
  EvalCaseResultSchema,
  EvalSetResult,
  EvalSetResultSchema,
  EvalStatus,
  createEvalSetResult,
  parseEvalSetResultJson,
  sanitizeEvalSetResultName,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as envAwareUtils from '../../src/utils/env_aware_utils.js';

vi.mock('../../src/utils/env_aware_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/env_aware_utils.js')>();
  return {
    ...actual,
    nowSeconds: vi.fn(() => actual.nowSeconds()),
    randomUUID: vi.fn(() => actual.randomUUID()),
  };
});

const MOCK_TIMESTAMP = 1700000000.5;

function makeEvalCaseResult(evalId: string): EvalCaseResult {
  return EvalCaseResultSchema.parse({
    evalSetId: 'set',
    evalId,
    finalEvalStatus: EvalStatus.PASSED,
    overallEvalMetricResults: [],
    evalMetricResultPerInvocation: [],
    sessionId: 'session1',
  });
}

describe('evaluation/eval_set_results_manager_utils', () => {
  beforeEach(() => {
    vi.mocked(envAwareUtils.nowSeconds).mockReturnValue(MOCK_TIMESTAMP);
  });

  afterEach(() => {
    vi.mocked(envAwareUtils.nowSeconds).mockReset();
  });

  describe('sanitizeEvalSetResultName', () => {
    it('replaces every slash with an underscore', () => {
      expect(sanitizeEvalSetResultName('a/b/c')).toBe('a_b_c');
    });

    it('leaves names without slashes unchanged', () => {
      expect(sanitizeEvalSetResultName('app_set_1')).toBe('app_set_1');
    });
  });

  describe('createEvalSetResult', () => {
    it('encodes the app name, eval set id, and timestamp in the id', () => {
      const result = createEvalSetResult('app', 'set', []);
      expect(result.evalSetResultId).toBe(`app_set_${MOCK_TIMESTAMP}`);
      expect(result.evalSetResultName).toBe(`app_set_${MOCK_TIMESTAMP}`);
      expect(result.evalSetId).toBe('set');
      expect(result.evalCaseResults).toEqual([]);
      expect(result.creationTimestamp).toBe(MOCK_TIMESTAMP);
    });

    it('sanitizes slashes out of the result name', () => {
      const result = createEvalSetResult('a/b', 'set', []);
      expect(result.evalSetResultId).toBe(`a/b_set_${MOCK_TIMESTAMP}`);
      expect(result.evalSetResultName).toBe(`a_b_set_${MOCK_TIMESTAMP}`);
    });
  });

  describe('parseEvalSetResultJson', () => {
    const snakeCaseJson = JSON.stringify({
      eval_set_result_id: 'app_set_1',
      eval_set_result_name: 'app_set_1',
      eval_set_id: 'set',
      eval_case_results: [
        {
          eval_set_id: 'set',
          eval_id: 'case1',
          final_eval_status: 1,
          overall_eval_metric_results: [],
          eval_metric_result_per_invocation: [],
          session_id: 'session1',
        },
      ],
      creation_timestamp: 1.5,
    });

    it('parses standard snake_case JSON', () => {
      const result = parseEvalSetResultJson(snakeCaseJson);
      expect(result.evalSetResultId).toBe('app_set_1');
      expect(result.evalSetId).toBe('set');
      expect(result.evalCaseResults[0].evalId).toBe('case1');
      expect(result.evalCaseResults[0].finalEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('parses camelCase-aliased JSON', () => {
      const camelCaseJson = JSON.stringify({
        evalSetResultId: 'app_set_1',
        evalSetResultName: 'app_set_1',
        evalSetId: 'set',
        evalCaseResults: [],
        creationTimestamp: 1.5,
      });
      const result = parseEvalSetResultJson(camelCaseJson);
      expect(result.evalSetResultId).toBe('app_set_1');
      expect(result.evalCaseResults).toEqual([]);
    });

    it('parses legacy double-encoded JSON', () => {
      const doubleEncoded = JSON.stringify(snakeCaseJson);
      const result = parseEvalSetResultJson(doubleEncoded);
      expect(result.evalSetResultId).toBe('app_set_1');
      expect(result.evalCaseResults[0].evalId).toBe('case1');
    });

    it('throws on an object missing required fields', () => {
      expect(() =>
        parseEvalSetResultJson('{"unexpected_field":"value"}'),
      ).toThrow();
    });

    it('throws on non-JSON input', () => {
      expect(() => parseEvalSetResultJson('invalid json')).toThrow();
    });

    it('round-trips an EvalSetResult built from the schema', () => {
      const original: EvalSetResult = EvalSetResultSchema.parse({
        evalSetResultId: 'app_set_1',
        evalSetResultName: 'app_set_1',
        evalSetId: 'set',
        evalCaseResults: [makeEvalCaseResult('case1')],
        creationTimestamp: 1.5,
      });
      // Serialize the way the manager does, via snake_case keys on disk.
      const onDisk = JSON.stringify({
        eval_set_result_id: original.evalSetResultId,
        eval_set_result_name: original.evalSetResultName,
        eval_set_id: original.evalSetId,
        eval_case_results: [
          {
            eval_set_id: 'set',
            eval_id: 'case1',
            final_eval_status: EvalStatus.PASSED,
            overall_eval_metric_results: [],
            eval_metric_result_per_invocation: [],
            session_id: 'session1',
          },
        ],
        creation_timestamp: original.creationTimestamp,
      });
      expect(parseEvalSetResultJson(onDisk)).toEqual(original);
    });
  });
});
