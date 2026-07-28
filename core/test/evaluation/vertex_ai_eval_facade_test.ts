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
import {afterEach, describe, expect, it, vi} from 'vitest';

function invocation(text?: string): Invocation {
  return InvocationSchema.parse({
    userContent: {parts: [{text: 'prompt'}]},
    ...(text !== undefined ? {finalResponse: {parts: [{text}]}} : {}),
  });
}

describe('evaluation/vertex_ai_eval_facade', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws by default from performEval (mockable seam)', () => {
    const facade = new SingleTurnVertexAiEvalFacade({
      metricName: PrebuiltMetric.SAFETY,
      threshold: 0.8,
    });
    expect(() =>
      facade.performEval({
        dataset: {evalCases: []},
        metrics: [PrebuiltMetric.SAFETY],
      }),
    ).toThrow('Vertex Gen AI Eval SDK is not available in adk-js');
  });

  it('throws when expected invocations are required but missing', () => {
    const facade = new SingleTurnVertexAiEvalFacade({
      metricName: PrebuiltMetric.COHERENCE,
      threshold: 0.8,
      expectedInvocationsRequired: true,
    });
    expect(() => facade.evaluateInvocations([invocation('x')])).toThrow(
      'expected_invocations is needed by this metric.',
    );
  });

  it('returns NOT_EVALUATED for no invocations', () => {
    const facade = new SingleTurnVertexAiEvalFacade({
      metricName: PrebuiltMetric.SAFETY,
      threshold: 0.8,
    });
    const result = facade.evaluateInvocations([], undefined);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toHaveLength(0);
  });

  it('marks an invocation NOT_EVALUATED when no score is returned', () => {
    vi.spyOn(VertexAiEvalFacade.prototype, 'performEval').mockReturnValue({
      summaryMetrics: [],
    });
    const facade = new SingleTurnVertexAiEvalFacade({
      metricName: PrebuiltMetric.SAFETY,
      threshold: 0.8,
    });
    // No expected invocations and an actual without a final response exercise
    // the reference/response empty-text branches.
    const result = facade.evaluateInvocations([invocation()], undefined);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });

  it('ignores a NaN mean score', () => {
    vi.spyOn(VertexAiEvalFacade.prototype, 'performEval').mockReturnValue({
      summaryMetrics: [{meanScore: Number.NaN}],
    });
    const facade = new SingleTurnVertexAiEvalFacade({
      metricName: PrebuiltMetric.SAFETY,
      threshold: 0.8,
    });
    const result = facade.evaluateInvocations([invocation('x')], undefined);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('fails a valid score below the threshold', () => {
    vi.spyOn(VertexAiEvalFacade.prototype, 'performEval').mockReturnValue({
      summaryMetrics: [{meanScore: 0.5}],
    });
    const facade = new SingleTurnVertexAiEvalFacade({
      metricName: PrebuiltMetric.SAFETY,
      threshold: 0.8,
    });
    const result = facade.evaluateInvocations(
      [invocation('x')],
      [invocation('x')],
    );
    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('fails when no threshold is configured', () => {
    vi.spyOn(VertexAiEvalFacade.prototype, 'performEval').mockReturnValue({
      summaryMetrics: [{meanScore: 0.9}],
    });
    const facade = new SingleTurnVertexAiEvalFacade({
      metricName: PrebuiltMetric.SAFETY,
    });
    const result = facade.evaluateInvocations(
      [invocation('x')],
      [invocation('x')],
    );
    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });
});
