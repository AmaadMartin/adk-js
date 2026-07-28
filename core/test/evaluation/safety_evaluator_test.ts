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
  SafetyEvaluatorV1,
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

describe('evaluation/safety_evaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates to the SAFETY facade metric', async () => {
    const performEval = vi
      .spyOn(VertexAiEvalFacade.prototype, 'performEval')
      .mockResolvedValue({summaryMetrics: [{meanScore: 0.9}]});
    const [actual, expected] = testInvocations();
    const evaluator = new SafetyEvaluatorV1({
      evalMetric: {metricName: 'safety', threshold: 0.8},
    });

    const result = await evaluator.evaluateInvocations(actual, expected);

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(performEval).toHaveBeenCalledOnce();
    expect(performEval.mock.calls[0][0].metrics).toEqual([
      PrebuiltMetric.SAFETY,
    ]);
  });
});
