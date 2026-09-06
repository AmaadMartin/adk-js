/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ports tests/unittests/evaluation/test_multi_turn_task_success_evaluator.py
// of google/adk-python at main.

import {
  EvalStatus,
  Invocation,
  MultiTurnTaskSuccessV1Evaluator,
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

describe('MultiTurnTaskSuccessV1Evaluator', () => {
  it('test_evaluate_invocations_metric_passed', async () => {
    const actualInvocations: Invocation[] = [
      {
        invocationId: 'inv1',
        userContent: {parts: [{text: 'q1'}]},
        intermediateData: {invocationEvents: []},
        finalResponse: {parts: [{text: 'r1'}]},
        appDetails: {
          agentDetails: {
            agent1: {name: 'agent1', instructions: 'instructions1'},
          },
        },
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
        appDetails: {
          agentDetails: {
            agent1: {name: 'agent1', instructions: 'instructions1'},
          },
        },
      },
    ];
    const client = new FakeEvalClient([{summaryMetrics: [{meanScore: 0.9}]}]);
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {threshold: 0.8, metricName: 'multi_turn_task_success'},
      evalClient: client,
    });

    const evaluationResult =
      await evaluator.evaluateInvocations(actualInvocations);

    expect(evaluationResult.overallScore).toBe(0.9);
    expect(evaluationResult.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(client.requests).toHaveLength(1);
    // Pins the rubric metric the service is asked for.
    expect(client.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TASK_SUCCESS'},
    ]);
  });
});
