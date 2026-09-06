/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests of `MultiTurnTaskSuccessV1Evaluator`.
 *
 * The `test_evaluate_invocations_metric_passed` case is ported from
 * `tests/unittests/evaluation/test_multi_turn_task_success_evaluator.py` at
 * `google/adk-python` commit `c7ef8cfa`, and keeps its name verbatim. The
 * reference patches `_VertexAiEvalFacade._perform_eval`; adk-js injects the
 * transport instead, so a recording `FakeEvalClient` replaces the patch. The
 * cases after it are this port's own.
 */

import {
  ConversationScenario,
  EvalStatus,
  Invocation,
  MultiTurnTaskSuccessV1Evaluator,
  PrebuiltMetrics,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A client that records its requests and replays one fixed result. */
class FakeEvalClient implements VertexAiEvalClient {
  readonly requests: VertexAiEvalRequest[] = [];

  constructor(private readonly result: VertexEvaluationResult = {}) {}

  async evaluate(
    request: VertexAiEvalRequest,
  ): Promise<VertexEvaluationResult> {
    this.requests.push(request);
    return this.result;
  }
}

function scored(meanScore: number): VertexEvaluationResult {
  return {summaryMetrics: [{meanScore}]};
}

function invocation(id: string): Invocation {
  return {
    invocationId: id,
    userContent: {parts: [{text: `q-${id}`}]},
    finalResponse: {parts: [{text: `r-${id}`}]},
  };
}

const SCENARIO: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan: 'Book a one-way flight from SFO to LAX for next Tuesday.',
};

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
    const evalClient = new FakeEvalClient(scored(0.9));
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {threshold: 0.8, metricName: 'multi_turn_task_success'},
      evalClient,
    });

    const evaluationResult =
      await evaluator.evaluateInvocations(actualInvocations);

    expect(evaluationResult.overallScore).toBe(0.9);
    expect(evaluationResult.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(evalClient.requests).toHaveLength(1);
    expect(evalClient.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TASK_SUCCESS'},
    ]);
  });

  it('fails a conversation scored below the threshold', async () => {
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
      },
      evalClient: new FakeEvalClient(scored(0.5)),
    });

    const result = await evaluator.evaluateInvocations([invocation('inv1')]);

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('passes a conversation scored exactly at the threshold', async () => {
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
      },
      evalClient: new FakeEvalClient(scored(0.8)),
    });

    const result = await evaluator.evaluateInvocations([invocation('inv1')]);

    expect(result.overallScore).toBe(0.8);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('reports not evaluated when the service returns no score', async () => {
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
      },
      evalClient: new FakeEvalClient({summaryMetrics: []}),
    });

    const result = await evaluator.evaluateInvocations([invocation('inv1')]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('prefers the criterion threshold over the deprecated one', async () => {
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
        criterion: {threshold: 0.95},
      },
      evalClient: new FakeEvalClient(scored(0.9)),
    });

    const result = await evaluator.evaluateInvocations([invocation('inv1')]);

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('rejects a metric that carries no threshold', () => {
    const evalClient = new FakeEvalClient(scored(0.9));

    expect(
      () =>
        new MultiTurnTaskSuccessV1Evaluator({
          evalMetric: {
            metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
          },
          evalClient,
        }),
    ).toThrow(
      "Evaluation metric 'multi_turn_task_success_v1' requires a threshold.",
    );
    expect(evalClient.requests).toHaveLength(0);
  });

  it('rejects invocation lists of different lengths', async () => {
    const evalClient = new FakeEvalClient(scored(0.9));
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
      },
      evalClient,
    });

    await expect(
      evaluator.evaluateInvocations(
        [invocation('inv1'), invocation('inv2')],
        [invocation('golden1')],
      ),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length;' +
        ' got 2 and 1.',
    );
    expect(evalClient.requests).toHaveLength(0);
  });

  it('evaluates nothing when there are no invocations', async () => {
    const evalClient = new FakeEvalClient(scored(0.9));
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
      },
      evalClient,
    });

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
    expect(evalClient.requests).toHaveLength(0);
  });

  it('sends one request for the whole conversation', async () => {
    const evalClient = new FakeEvalClient(scored(0.9));
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
      },
      evalClient,
    });

    const result = await evaluator.evaluateInvocations([
      invocation('inv1'),
      invocation('inv2'),
      invocation('inv3'),
    ]);

    expect(evalClient.requests).toHaveLength(1);
    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.NOT_EVALUATED,
      EvalStatus.NOT_EVALUATED,
      EvalStatus.PASSED,
    ]);
    expect(result.perInvocationResults.map((r) => r.score)).toEqual([
      undefined,
      undefined,
      0.9,
    ]);
  });

  it('forwards the expected invocations and the conversation scenario', async () => {
    const evalClient = new FakeEvalClient(scored(0.9));
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
      },
      evalClient,
    });
    const actual = [invocation('inv1'), invocation('inv2')];
    const expected = [invocation('golden1'), invocation('golden2')];

    const result = await evaluator.evaluateInvocations(
      actual,
      expected,
      SCENARIO,
    );

    const evalCases = evalClient.requests[0].dataset.evalCases;
    expect(evalCases[0].agentData.turns.map((turn) => turn.turnId)).toEqual([
      'inv1',
      'inv2',
    ]);
    expect(
      result.perInvocationResults.map((r) => r.expectedInvocation),
    ).toEqual(expected);
    expect(result.perInvocationResults.map((r) => r.actualInvocation)).toEqual(
      actual,
    );
  });

  it('propagates a rejection from the client unchanged', async () => {
    const failure = new Error('the service is unreachable');
    const evaluator = new MultiTurnTaskSuccessV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
        threshold: 0.8,
      },
      evalClient: {
        evaluate: () => Promise.reject(failure),
      },
    });

    await expect(
      evaluator.evaluateInvocations([invocation('inv1')]),
    ).rejects.toBe(failure);
  });
});
