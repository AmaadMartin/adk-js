/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  type Invocation,
  InvocationSchema,
  PrebuiltMetric,
  SingleTurnVertexAiEvalFacade,
  VertexAiEvalFacade,
} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Mock google-auth-library; the implementation is (re)installed per transport
// test so it survives vi.restoreAllMocks() from the aggregation suite. The
// auth-header extraction itself is covered by utils/google_cloud_auth_test.ts.
vi.mock('google-auth-library', () => ({GoogleAuth: vi.fn()}));

function installAuthMock(): void {
  vi.mocked(GoogleAuth).mockImplementation(
    () =>
      ({
        getClient: async () => ({
          getRequestHeaders: async () => ({Authorization: 'Bearer fake-token'}),
          credentials: {},
        }),
      }) as unknown as GoogleAuth,
  );
}

function fetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function invocation(text?: string): Invocation {
  return InvocationSchema.parse({
    userContent: {parts: [{text: 'prompt'}]},
    ...(text !== undefined ? {finalResponse: {parts: [{text}]}} : {}),
  });
}

const ENDPOINT_URL =
  'https://us-central1-aiplatform.googleapis.com/v1/projects/' +
  'test-project/locations/us-central1:evaluateInstances';

describe('evaluation/vertex_ai_eval_facade', () => {
  describe('aggregation (mocked performEval seam)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns NOT_EVALUATED when there are no invocations', async () => {
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
        threshold: 0.8,
      });
      const result = await facade.evaluateInvocations([], undefined);
      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
      expect(result.perInvocationResults).toHaveLength(0);
    });

    it('records no score when the result has no summary metrics', async () => {
      vi.spyOn(VertexAiEvalFacade.prototype, 'performEval').mockResolvedValue({
        summaryMetrics: [],
      });
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
        threshold: 0.8,
      });
      // An actual without a final response and no expected invocation exercises
      // the empty-text and undefined-reference branches.
      const result = await facade.evaluateInvocations(
        [invocation()],
        undefined,
      );
      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
      expect(result.perInvocationResults[0].score).toBeUndefined();
      expect(result.perInvocationResults[0].evalStatus).toBe(
        EvalStatus.NOT_EVALUATED,
      );
    });

    it('ignores a NaN mean score', async () => {
      vi.spyOn(VertexAiEvalFacade.prototype, 'performEval').mockResolvedValue({
        summaryMetrics: [{meanScore: Number.NaN}],
      });
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
        threshold: 0.8,
      });
      const result = await facade.evaluateInvocations(
        [invocation('x')],
        undefined,
      );
      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    });

    it('throws when expected invocations are required but missing', async () => {
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.COHERENCE,
        threshold: 0.8,
        expectedInvocationsRequired: true,
      });
      await expect(
        facade.evaluateInvocations([invocation('x')]),
      ).rejects.toThrow('expected_invocations is needed by this metric.');
    });
  });

  describe('performEval transport (mocked fetch + auth)', () => {
    let savedProject: string | undefined;
    let savedLocation: string | undefined;

    beforeEach(() => {
      installAuthMock();
      global.fetch = vi.fn();
      savedProject = process.env.GOOGLE_CLOUD_PROJECT;
      savedLocation = process.env.GOOGLE_CLOUD_LOCATION;
      process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
      process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
    });

    afterEach(() => {
      process.env.GOOGLE_CLOUD_PROJECT = savedProject;
      process.env.GOOGLE_CLOUD_LOCATION = savedLocation;
      if (savedProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      if (savedLocation === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
      vi.restoreAllMocks();
    });

    it('scores COHERENCE against the regional endpoint and passes', async () => {
      vi.mocked(fetch).mockResolvedValue(
        fetchResponse({coherenceResult: {score: 4, explanation: 'ok'}}),
      );
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.COHERENCE,
        threshold: 3,
        expectedInvocationsRequired: true,
      });

      const result = await facade.evaluateInvocations(
        [invocation('the answer')],
        [invocation('golden')],
      );

      expect(result.overallScore).toBe(4);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults).toHaveLength(1);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe(ENDPOINT_URL);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer fake-token');
      const body = JSON.parse(init?.body as string);
      expect(body.coherenceInput.instance.prediction).toBe('the answer');
      expect(body.coherenceInput.metricSpec).toEqual({});
      expect(body.safetyInput).toBeUndefined();
    });

    it('scores SAFETY and passes above threshold', async () => {
      vi.mocked(fetch).mockResolvedValue(
        fetchResponse({safetyResult: {score: 0.9}}),
      );
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
        threshold: 0.5,
      });

      const result = await facade.evaluateInvocations([invocation('safe')]);

      expect(result.overallScore).toBe(0.9);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      const body = JSON.parse(
        vi.mocked(fetch).mock.calls[0][1]?.body as string,
      );
      expect(body.safetyInput.instance.prediction).toBe('safe');
      expect(body.coherenceInput).toBeUndefined();
    });

    it('fails SAFETY below threshold', async () => {
      vi.mocked(fetch).mockResolvedValue(
        fetchResponse({safetyResult: {score: 0.2}}),
      );
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
        threshold: 0.5,
      });

      const result = await facade.evaluateInvocations([invocation('unsafe')]);

      expect(result.overallScore).toBe(0.2);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('fails a scored invocation when no threshold is configured', async () => {
      vi.mocked(fetch).mockResolvedValue(
        fetchResponse({safetyResult: {score: 0.9}}),
      );
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
      });

      const result = await facade.evaluateInvocations([invocation('safe')]);

      expect(result.overallScore).toBe(0.9);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it.each([
      ['a missing result object', {}],
      ['an absent score', {coherenceResult: {}}],
      ['a null score', {coherenceResult: {score: null}}],
      ['a NaN score', {coherenceResult: {score: Number.NaN}}],
    ])('maps %s to NOT_EVALUATED', async (_label, responseBody) => {
      vi.mocked(fetch).mockResolvedValue(fetchResponse(responseBody));
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.COHERENCE,
        threshold: 3,
        expectedInvocationsRequired: true,
      });

      const result = await facade.evaluateInvocations(
        [invocation('resp')],
        [invocation('ref')],
      );

      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
      expect(result.perInvocationResults[0].score).toBeUndefined();
    });

    it('averages scores across multiple invocations', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(fetchResponse({safetyResult: {score: 0.4}}))
        .mockResolvedValueOnce(fetchResponse({safetyResult: {score: 0.8}}));
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
        threshold: 0.5,
      });

      const result = await facade.evaluateInvocations([
        invocation('a'),
        invocation('b'),
      ]);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.overallScore).toBeCloseTo(0.6, 10);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults).toHaveLength(2);
      expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.FAILED);
      expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.PASSED);
    });

    it('throws on a non-2xx response with the status and body', async () => {
      vi.mocked(fetch).mockResolvedValue(
        fetchResponse('quota exceeded', false, 429),
      );
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
        threshold: 0.5,
      });

      await expect(
        facade.evaluateInvocations([invocation('x')]),
      ).rejects.toThrow(
        ':evaluateInstances request failed with status 429: quota exceeded',
      );
    });

    it.each([
      ['project', 'GOOGLE_CLOUD_PROJECT'],
      ['location', 'GOOGLE_CLOUD_LOCATION'],
    ])('throws a clear error when %s is missing', async (_label, envKey) => {
      delete process.env[envKey];
      const facade = new SingleTurnVertexAiEvalFacade({
        metricName: PrebuiltMetric.SAFETY,
        threshold: 0.5,
      });

      await expect(
        facade.evaluateInvocations([invocation('x')]),
      ).rejects.toThrow('GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
