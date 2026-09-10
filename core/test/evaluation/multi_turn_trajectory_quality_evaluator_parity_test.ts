/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python
 * `tests/unittests/evaluation/test_multi_turn_trajectory_quality_evaluator.py`
 * at `main`. Each `it` keeps its Python test name so a reader can grep the
 * original.
 *
 * The reference file has 1 test and it is here.
 *
 * One adaptation. The reference mocks `_VertexAiEvalFacade._perform_eval`;
 * adk-js has no such seam and does not need one, because the transport is an
 * injected `VertexAiEvalClient`. A fake client is the ported form of that
 * mock, and it asserts more: it inspects the request the facade built.
 */

import {
  EvalStatus,
  MultiTurnTrajectoryQualityV1Evaluator,
  type EvalMetric,
  type Invocation,
  type VertexAiEvalClient,
  type VertexAiEvalRequest,
  type VertexEvaluationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A client that records every request and replays one fixed result. */
class FakeEvalClient implements VertexAiEvalClient {
  readonly requests: VertexAiEvalRequest[] = [];

  constructor(private readonly result: VertexEvaluationResult) {}

  async evaluate(
    request: VertexAiEvalRequest,
  ): Promise<VertexEvaluationResult> {
    this.requests.push(request);
    return this.result;
  }
}

const APP_DETAILS = {
  agentDetails: {
    agent1: {name: 'agent1', instructions: 'instructions1'},
  },
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

describe('MultiTurnTrajectoryQualityV1Evaluator', () => {
  it('test_evaluate_invocations_metric_passed', async () => {
    const evalMetric: EvalMetric = {
      threshold: 0.8,
      metricName: 'multi_turn_trajectory_quality',
    };
    const evalClient = new FakeEvalClient({summaryMetrics: [{meanScore: 0.9}]});
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric,
      evalClient,
    });

    const evaluationResult =
      await evaluator.evaluateInvocations(ACTUAL_INVOCATIONS);

    expect(evaluationResult.overallScore).toBe(0.9);
    expect(evaluationResult.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(evalClient.requests).toHaveLength(1);
    expect(evalClient.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TRAJECTORY_QUALITY'},
    ]);
  });
});
