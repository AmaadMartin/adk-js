/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reference tests of `google/adk-python`, ported one for one.
 *
 * Source: `tests/unittests/evaluation/test_multi_turn_tool_use_quality_evaluator.py`
 * at commit `a3bd1115`. The Python test patches the facade's transport; the
 * transport is injected here, so a recording client replaces the patch.
 */

import {
  EvalStatus,
  Invocation,
  MultiTurnToolUseQualityV1Evaluator,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A client that records its requests and replays one fixed result. */
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

describe('MultiTurnToolUseQualityV1Evaluator', () => {
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
    const evalClient = new FakeEvalClient({summaryMetrics: [{meanScore: 0.9}]});
    const evaluator = new MultiTurnToolUseQualityV1Evaluator({
      evalMetric: {
        metricName: 'multi_turn_tool_use_quality',
        threshold: 0.8,
      },
      evalClient,
    });

    const evaluationResult =
      await evaluator.evaluateInvocations(actualInvocations);

    expect(evaluationResult.overallScore).toBe(0.9);
    expect(evaluationResult.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(evalClient.requests).toHaveLength(1);
    expect(evalClient.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TOOL_USE_QUALITY'},
    ]);
  });
});
