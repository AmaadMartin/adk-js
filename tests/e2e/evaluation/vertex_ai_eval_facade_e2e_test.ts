/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  InvocationSchema,
  PrebuiltMetrics,
  ResponseEvaluator,
  SafetyEvaluatorV1,
} from '@google/adk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

/**
 * Live, unmocked evaluation against the Vertex AI `:evaluateInstances` endpoint.
 *
 * Skipped unless GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are set (with
 * Application Default Credentials available). Each scored invocation performs
 * one LLM-judge call and therefore consumes Google Cloud quota/billing.
 */
describe('E2E Live single-turn Vertex AI eval facade', () => {
  const envPath = path.resolve(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  const hasLiveCredentials =
    !!process.env.GOOGLE_CLOUD_PROJECT && !!process.env.GOOGLE_CLOUD_LOCATION;

  const actual = [
    InvocationSchema.parse({
      userContent: {parts: [{text: 'What is the capital of France?'}]},
      finalResponse: {parts: [{text: 'The capital of France is Paris.'}]},
    }),
  ];
  const expected = [
    InvocationSchema.parse({
      userContent: {parts: [{text: 'What is the capital of France?'}]},
      finalResponse: {parts: [{text: 'Paris is the capital of France.'}]},
    }),
  ];

  it.skipIf(!hasLiveCredentials)(
    'scores COHERENCE via ResponseEvaluator against the live endpoint',
    async () => {
      const evaluator = new ResponseEvaluator({
        threshold: 3,
        metricName: PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
      });

      const result = await evaluator.evaluateInvocations(actual, expected);

      expect(result.perInvocationResults).toHaveLength(1);
      expect(typeof result.overallScore).toBe('number');
      expect(Number.isFinite(result.overallScore!)).toBe(true);
      expect([EvalStatus.PASSED, EvalStatus.FAILED]).toContain(
        result.overallEvalStatus,
      );
    },
    60000,
  );

  it.skipIf(!hasLiveCredentials)(
    'scores SAFETY via SafetyEvaluatorV1 against the live endpoint',
    async () => {
      const evaluator = new SafetyEvaluatorV1({
        evalMetric: {metricName: PrebuiltMetrics.SAFETY_V1, threshold: 0.5},
      });

      const result = await evaluator.evaluateInvocations(actual);

      expect(result.perInvocationResults).toHaveLength(1);
      expect(typeof result.overallScore).toBe('number');
      expect(Number.isFinite(result.overallScore!)).toBe(true);
      expect([EvalStatus.PASSED, EvalStatus.FAILED]).toContain(
        result.overallEvalStatus,
      );
    },
    60000,
  );
});
