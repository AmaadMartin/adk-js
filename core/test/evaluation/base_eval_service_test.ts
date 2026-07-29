/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseEvalService,
  EvalCaseResultSchema,
  EvalStatus,
  EvaluateConfigSchema,
  EvaluateRequestSchema,
  InferenceConfigSchema,
  InferenceRequestSchema,
  InferenceResultSchema,
  InferenceStatus,
  type EvalCaseResult,
  type EvaluateRequest,
  type InferenceRequest,
  type InferenceResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/base_eval_service', () => {
  describe('InferenceStatus', () => {
    it('uses the adk-python integer values', () => {
      expect(InferenceStatus.UNKNOWN).toBe(0);
      expect(InferenceStatus.SUCCESS).toBe(1);
      expect(InferenceStatus.FAILURE).toBe(2);
    });
  });

  describe('EvaluateConfigSchema', () => {
    it('applies the parallelism default', () => {
      const config = EvaluateConfigSchema.parse({evalMetrics: []});
      expect(config.evalMetrics).toEqual([]);
      expect(config.parallelism).toBe(4);
    });
  });

  describe('InferenceConfigSchema', () => {
    it('applies the documented defaults', () => {
      const config = InferenceConfigSchema.parse({});
      expect(config.parallelism).toBe(4);
      expect(config.useLive).toBe(false);
      expect(config.liveTimeoutSeconds).toBe(300);
      expect(config.labels).toBeUndefined();
    });
  });

  describe('InferenceRequestSchema', () => {
    it('parses a minimal request and applies nested defaults', () => {
      const request = InferenceRequestSchema.parse({
        appName: 'my-app',
        evalSetId: 'my-set',
        inferenceConfig: {},
      });
      expect(request.appName).toBe('my-app');
      expect(request.evalSetId).toBe('my-set');
      expect(request.evalCaseIds).toBeUndefined();
      expect(request.inferenceConfig.parallelism).toBe(4);
    });
  });

  describe('InferenceResultSchema', () => {
    it('applies the status default and accepts a null sessionId', () => {
      const result = InferenceResultSchema.parse({
        appName: 'my-app',
        evalSetId: 'my-set',
        evalCaseId: 'my-case',
        sessionId: null,
      });
      expect(result.status).toBe(InferenceStatus.UNKNOWN);
      expect(result.sessionId).toBeNull();
      expect(result.inferences).toBeUndefined();
      expect(result.errorMessage).toBeUndefined();
    });

    it('accepts a string sessionId and explicit status', () => {
      const result = InferenceResultSchema.parse({
        appName: 'my-app',
        evalSetId: 'my-set',
        evalCaseId: 'my-case',
        sessionId: 'session-1',
        status: InferenceStatus.SUCCESS,
        errorMessage: 'boom',
      });
      expect(result.sessionId).toBe('session-1');
      expect(result.status).toBe(InferenceStatus.SUCCESS);
      expect(result.errorMessage).toBe('boom');
    });

    it('requires the sessionId key', () => {
      const result = InferenceResultSchema.safeParse({
        appName: 'my-app',
        evalSetId: 'my-set',
        evalCaseId: 'my-case',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('EvaluateRequestSchema', () => {
    it('parses a minimal request', () => {
      const request = EvaluateRequestSchema.parse({
        inferenceResults: [],
        evaluateConfig: {evalMetrics: []},
      });
      expect(request.inferenceResults).toEqual([]);
      expect(request.evaluateConfig.parallelism).toBe(4);
    });
  });

  describe('BaseEvalService', () => {
    class TestEvalService extends BaseEvalService {
      async *performInference(
        request: InferenceRequest,
      ): AsyncGenerator<InferenceResult, void, void> {
        yield InferenceResultSchema.parse({
          appName: request.appName,
          evalSetId: request.evalSetId,
          evalCaseId: 'case-1',
          sessionId: 'session-1',
          status: InferenceStatus.SUCCESS,
        });
      }

      async *evaluate(
        _request: EvaluateRequest,
      ): AsyncGenerator<EvalCaseResult, void, void> {
        yield EvalCaseResultSchema.parse({
          evalSetId: 'my-set',
          evalId: 'case-1',
          finalEvalStatus: EvalStatus.PASSED,
          overallEvalMetricResults: [],
          evalMetricResultPerInvocation: [],
          sessionId: 'session-1',
        });
      }
    }

    it('supports subclassing with async-generator methods', async () => {
      const service = new TestEvalService();

      const inferenceResults: InferenceResult[] = [];
      for await (const result of service.performInference(
        InferenceRequestSchema.parse({
          appName: 'my-app',
          evalSetId: 'my-set',
          inferenceConfig: {},
        }),
      )) {
        inferenceResults.push(result);
      }
      expect(inferenceResults).toHaveLength(1);
      expect(inferenceResults[0].appName).toBe('my-app');
      expect(inferenceResults[0].status).toBe(InferenceStatus.SUCCESS);

      const caseResults: EvalCaseResult[] = [];
      for await (const result of service.evaluate(
        EvaluateRequestSchema.parse({
          inferenceResults: [],
          evaluateConfig: {evalMetrics: []},
        }),
      )) {
        caseResults.push(result);
      }
      expect(caseResults).toHaveLength(1);
      expect(caseResults[0].finalEvalStatus).toBe(EvalStatus.PASSED);
    });
  });
});
