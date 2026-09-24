/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `test_evaluate_invocations_metric_passed` is ported from `google/adk-python`
 * `tests/unittests/evaluation/test_multi_turn_trajectory_quality_evaluator.py`
 * at `main`, and keeps its Python name. The rest cover behaviour the Python
 * suite does not.
 */

import {
  ConversationScenario,
  EvalStatus,
  InputValidationError,
  Invocation,
  MultiTurnTrajectoryQualityV1Evaluator,
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

function scored(meanScore: number): VertexEvaluationResult {
  return {summaryMetrics: [{meanScore}]};
}

function invocation(query: string, response: string): Invocation {
  return {
    userContent: {parts: [{text: query}]},
    finalResponse: {parts: [{text: response}]},
  };
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

const SCENARIO: ConversationScenario = {
  startingPrompt: 'Book me a flight.',
  conversationPlan: 'Ask for a window seat, then confirm.',
};

describe('MultiTurnTrajectoryQualityV1Evaluator', () => {
  it('test_evaluate_invocations_metric_passed', async () => {
    const evalClient = new FakeEvalClient([
      {summaryMetrics: [{meanScore: 0.9}]},
    ]);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient,
    });

    const result = await evaluator.evaluateInvocations(ACTUAL_INVOCATIONS);

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(evalClient.requests).toHaveLength(1);
    expect(evalClient.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TRAJECTORY_QUALITY'},
    ]);
  });

  it('prefers the criterion threshold over the deprecated one', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.4,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([scored(0.5)]),
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
    ]);

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('rejects a metric that carries no threshold on construction', () => {
    expect(
      () =>
        new MultiTurnTrajectoryQualityV1Evaluator({
          evalMetric: {
            metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
          },
          evalClient: new FakeEvalClient([scored(0.9)]),
        }),
    ).toThrow(
      new InputValidationError(
        "Evaluation metric 'multi_turn_trajectory_quality_v1' requires a" +
          ' threshold.',
      ),
    );
  });

  it('fails a conversation scored below the threshold', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([scored(0.5)]),
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
    ]);

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('scores only the last turn of a conversation', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
      invocation('q2', 'r2'),
      invocation('q3', 'r3'),
    ]);

    expect(
      result.perInvocationResults.map((perInvocation) => [
        perInvocation.score,
        perInvocation.evalStatus,
      ]),
    ).toEqual([
      [undefined, EvalStatus.NOT_EVALUATED],
      [undefined, EvalStatus.NOT_EVALUATED],
      [0.9, EvalStatus.PASSED],
    ]);
    expect(result.overallScore).toBe(0.9);
  });

  it('forwards a conversation scenario without changing the request', async () => {
    const withScenario = new FakeEvalClient([scored(0.9)]);
    const withoutScenario = new FakeEvalClient([scored(0.9)]);
    const evalMetric = {
      metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
      criterion: {threshold: 0.8},
    };
    const invocations = [invocation('q1', 'r1'), invocation('q2', 'r2')];

    const scenarioResult = await new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric,
      evalClient: withScenario,
    }).evaluateInvocations(invocations, undefined, SCENARIO);
    const plainResult = await new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric,
      evalClient: withoutScenario,
    }).evaluateInvocations(invocations);

    expect(withScenario.requests).toEqual(withoutScenario.requests);
    expect(scenarioResult).toEqual(plainResult);
  });

  it('pairs every turn with its golden invocation', async () => {
    const expected = [invocation('q1', 'golden1'), invocation('q2', 'golden2')];
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations(
      [invocation('q1', 'r1'), invocation('q2', 'r2')],
      expected,
    );

    expect(
      result.perInvocationResults.map(
        (perInvocation) => perInvocation.expectedInvocation,
      ),
    ).toEqual(expected);
  });

  it('rejects expected invocations of a different length', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient,
    });

    await expect(
      evaluator.evaluateInvocations(
        [invocation('q1', 'r1'), invocation('q2', 'r2')],
        [invocation('q1', 'golden1')],
      ),
    ).rejects.toThrow(InputValidationError);
    expect(evalClient.requests).toEqual([]);
  });

  it('propagates a rejection from the client', async () => {
    const failure = new Error('service unavailable');
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        criterion: {threshold: 0.8},
      },
      evalClient: {
        evaluate: () => Promise.reject(failure),
      },
    });

    await expect(
      evaluator.evaluateInvocations([invocation('q1', 'r1')]),
    ).rejects.toBe(failure);
  });
});
