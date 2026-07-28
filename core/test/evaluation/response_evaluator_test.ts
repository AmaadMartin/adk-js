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
  PrebuiltMetrics,
  ResponseEvaluator,
  VertexAiEvalFacade,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const QUERY = {parts: [{text: 'This is a test query.'}]};

function testInvocations(): [Invocation[], Invocation[]] {
  const actual = [
    InvocationSchema.parse({
      userContent: QUERY,
      finalResponse: {parts: [{text: 'This is a test candidate response.'}]},
    }),
  ];
  const expected = [
    InvocationSchema.parse({
      userContent: QUERY,
      finalResponse: {parts: [{text: 'This is a test reference.'}]},
    }),
  ];
  return [actual, expected];
}

describe('evaluation/response_evaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the RougeEvaluator for response_match_score', () => {
    const performEval = vi.spyOn(VertexAiEvalFacade.prototype, 'performEval');
    const [actual, expected] = testInvocations();
    const evaluator = new ResponseEvaluator({
      threshold: 0.8,
      metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
    });

    const result = evaluator.evaluateInvocations(actual, expected);

    expect(result.overallScore).toBeCloseTo(8 / 11, 10);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(performEval).not.toHaveBeenCalled();
  });

  it('delegates response_evaluation_score to the COHERENCE facade metric', () => {
    const performEval = vi
      .spyOn(VertexAiEvalFacade.prototype, 'performEval')
      .mockReturnValue({summaryMetrics: [{meanScore: 0.9}]});
    const [actual, expected] = testInvocations();
    const evaluator = new ResponseEvaluator({
      threshold: 0.8,
      metricName: PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
    });

    const result = evaluator.evaluateInvocations(actual, expected);

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(performEval).toHaveBeenCalledOnce();
    expect(performEval.mock.calls[0][0].metrics).toEqual([
      PrebuiltMetric.COHERENCE,
    ]);
  });

  it('resolves threshold and metric name from an eval metric', () => {
    vi.spyOn(VertexAiEvalFacade.prototype, 'performEval');
    const [actual, expected] = testInvocations();
    const evaluator = new ResponseEvaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
        threshold: 0.8,
      },
    });

    const result = evaluator.evaluateInvocations(actual, expected);

    expect(result.overallScore).toBeCloseTo(8 / 11, 10);
  });

  it('throws when both threshold and evalMetric are specified', () => {
    expect(
      () =>
        new ResponseEvaluator({
          threshold: 0.8,
          evalMetric: {
            metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
            threshold: 0.8,
          },
        }),
    ).toThrow(
      'Either eval_metric should be specified or both threshold and metric_name' +
        ' should be specified.',
    );
  });

  it('throws when both metricName and evalMetric are specified', () => {
    expect(
      () =>
        new ResponseEvaluator({
          metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
          evalMetric: {
            metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
            threshold: 0.8,
          },
        }),
    ).toThrow(
      'Either eval_metric should be specified or both threshold and metric_name' +
        ' should be specified.',
    );
  });

  it('throws for an unsupported metric', () => {
    expect(
      () => new ResponseEvaluator({threshold: 0.8, metricName: 'bogus_metric'}),
    ).toThrow('`bogus_metric` is not supported.');
  });
});
