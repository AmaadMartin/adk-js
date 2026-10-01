/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCaseResultSchema,
  EvalSetResultSchema,
  EvalStatus,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/eval_result', () => {
  describe('EvalCaseResultSchema', () => {
    it('applies defaults and requires finalEvalStatus/sessionId', () => {
      const result = EvalCaseResultSchema.parse({
        finalEvalStatus: EvalStatus.PASSED,
        overallEvalMetricResults: [],
        evalMetricResultPerInvocation: [],
        sessionId: 'session-1',
      });
      expect(result.evalSetId).toBe('');
      expect(result.evalId).toBe('');
      expect(result.userId).toBeUndefined();
      expect(result.sessionDetails).toBeUndefined();
    });

    it('serializes EvalStatus as an integer', () => {
      const result = EvalCaseResultSchema.parse({
        finalEvalStatus: EvalStatus.FAILED,
        overallEvalMetricResults: [],
        evalMetricResultPerInvocation: [],
        sessionId: 'session-1',
      });
      const serialized = JSON.parse(JSON.stringify(result));
      expect(serialized.finalEvalStatus).toBe(2);
    });

    it('rejects unknown keys (strict)', () => {
      expect(
        EvalCaseResultSchema.safeParse({
          finalEvalStatus: EvalStatus.PASSED,
          overallEvalMetricResults: [],
          evalMetricResultPerInvocation: [],
          sessionId: 'session-1',
          extra: 1,
        }).success,
      ).toBe(false);
    });
  });

  describe('EvalSetResultSchema', () => {
    it('applies defaults for evalCaseResults and creationTimestamp', () => {
      const result = EvalSetResultSchema.parse({
        evalSetResultId: 'result-1',
        evalSetId: 'set-1',
      });
      expect(result.evalCaseResults).toEqual([]);
      expect(result.creationTimestamp).toBe(0);
      expect(result.evalSetResultName).toBeUndefined();
    });
  });
});
