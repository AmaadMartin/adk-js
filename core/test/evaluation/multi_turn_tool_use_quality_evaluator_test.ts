/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_multi_turn_tool_use_quality_evaluator.py`
 * at `main`.
 */

import {
  EvalStatus,
  Invocation,
  MultiTurnToolUseQualityV1Evaluator,
  PrebuiltMetrics,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A client that replays the given results, one per call. */
class FakeEvalClient implements VertexAiEvalClient {
  readonly requests: VertexAiEvalRequest[] = [];

  constructor(private readonly results: VertexEvaluationResult[]) {}

  async evaluate(
    request: VertexAiEvalRequest,
  ): Promise<VertexEvaluationResult> {
    this.requests.push(request);
    return this.results[this.requests.length - 1];
  }
}

const APP_DETAILS = {
  agentDetails: {agent1: {name: 'agent1', instructions: 'instructions1'}},
};

const ACTUAL_INVOCATIONS: Invocation[] = [
  {
    invocationId: 'inv1',
    userContent: {parts: [{text: 'q1'}]},
    intermediateData: {invocationEvents: []},
    finalResponse: {parts: [{text: 'r1'}]},
    appDetails: APP_DETAILS,
  },
  {
    invocationId: 'inv2',
    userContent: {parts: [{text: 'q2'}]},
    intermediateData: {
      invocationEvents: [
        {author: 'agent1', content: {parts: [{text: 'intermediate'}]}},
      ],
    },
    finalResponse: {parts: [{text: 'r2'}]},
    appDetails: APP_DETAILS,
  },
];

describe('MultiTurnToolUseQualityV1Evaluator', () => {
  it('test_evaluate_invocations_metric_passed', async () => {
    const evalClient = new FakeEvalClient([
      {summaryMetrics: [{meanScore: 0.9}]},
    ]);
    const evaluator = new MultiTurnToolUseQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TOOL_USE_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient,
    });

    const result = await evaluator.evaluateInvocations(ACTUAL_INVOCATIONS);

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(evalClient.requests).toHaveLength(1);
    expect(evalClient.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TOOL_USE_QUALITY'},
    ]);
  });
});
