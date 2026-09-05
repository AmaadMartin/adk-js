/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  MultiTurnTrajectoryQualityV1Evaluator,
  MultiTurnVertexAiEvalFacade,
  PrebuiltMetrics,
  type ConversationScenario,
  type Invocation,
  type VertexAiEvalClient,
  type VertexAiEvalRequest,
  type VertexEvaluationResult,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

function invocation(query: string, response: string): Invocation {
  return {
    userContent: {parts: [{text: query}]},
    finalResponse: {parts: [{text: response}]},
  };
}

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

describe('MultiTurnTrajectoryQualityV1Evaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The reference tests of `google/adk-python`, ported one for one.
   *
   * Source: `tests/unittests/evaluation/test_multi_turn_trajectory_quality_evaluator.py`
   * at `main`. The Python test patches the facade's transport; the transport
   * is injected here, so a recording client replaces the patch.
   */
  describe('adk-python reference tests', () => {
    it('test_evaluate_invocations_metric_passed', async () => {
      const evalClient = new FakeEvalClient([
        {summaryMetrics: [{meanScore: 0.9}]},
      ]);
      const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
        evalMetric: {
          metricName: 'multi_turn_trajectory_quality',
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
  });

  it('scores a conversation and requests the multi-turn trajectory metric', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient,
    });

    const result = await evaluator.evaluateInvocations([
      invocation('Book me a flight.', 'Booked.'),
    ]);

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(evalClient.requests).toHaveLength(1);
    expect(evalClient.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TRAJECTORY_QUALITY'},
    ]);
  });

  it('fails a conversation scored below the threshold', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient: new FakeEvalClient([scored(0.5)]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('reports not evaluated when the service returns no score', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient: new FakeEvalClient([{summaryMetrics: []}]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('scores only the last turn of a conversation', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
      invocation('q2', 'r2'),
      invocation('q3', 'r3'),
    ]);

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

  it('sends one request carrying the conversation as an eval case', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient,
    });

    await evaluator.evaluateInvocations([
      invocation('q1', 'r1'),
      invocation('q2', 'r2'),
    ]);

    expect(evalClient.requests).toHaveLength(1);
    const dataset = evalClient.requests[0].dataset;
    expect(dataset.evalDataset).toBeUndefined();
    expect(dataset.evalCases).toHaveLength(1);
    expect(dataset.evalCases?.[0].agentData.turns).toHaveLength(2);
  });

  it('reads the threshold from the criterion', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        criterion: {threshold: 0.95},
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('reads the deprecated metric-level threshold', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('prefers the criterion threshold over the deprecated one', async () => {
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
        criterion: {threshold: 0.95},
      },
      evalClient: new FakeEvalClient([scored(0.9)]),
    });

    const result = await evaluator.evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('rejects a metric that carries no threshold, at construction', () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);

    expect(
      () =>
        new MultiTurnTrajectoryQualityV1Evaluator({
          evalMetric: {
            metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
          },
          evalClient,
        }),
    ).toThrow(
      "Evaluation metric 'multi_turn_trajectory_quality_v1' requires a" +
        ' threshold.',
    );
    expect(evalClient.requests).toHaveLength(0);
  });

  it('rejects invocation lists of different lengths', async () => {
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient,
    });

    await expect(
      evaluator.evaluateInvocations(
        [invocation('q', 'a'), invocation('q2', 'a2')],
        [invocation('q', 'a')],
      ),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length;' +
        ' got 2 and 1.',
    );
    expect(evalClient.requests).toHaveLength(0);
  });

  it('evaluates nothing when there are no invocations', async () => {
    const evalClient = new FakeEvalClient([]);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
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

  it('forwards the conversation scenario to the facade', async () => {
    const scenario: ConversationScenario = {
      startingPrompt: 'Book me a flight.',
      conversationPlan: 'Book a one-way flight from SFO to LAX.',
    };
    const delegate = vi.spyOn(
      MultiTurnVertexAiEvalFacade.prototype,
      'evaluateInvocations',
    );
    const evalClient = new FakeEvalClient([scored(0.9)]);
    const evaluator = new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric: {
        metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
        threshold: 0.8,
      },
      evalClient,
    });
    const actual = [invocation('q', 'a')];
    const expected = [invocation('q', 'golden')];

    const result = await evaluator.evaluateInvocations(
      actual,
      expected,
      scenario,
    );

    expect(delegate).toHaveBeenCalledExactlyOnceWith(
      actual,
      expected,
      scenario,
    );
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('forwards a conversation scenario without changing the request', async () => {
    const scenario: ConversationScenario = {
      startingPrompt: 'Book me a flight.',
      conversationPlan: 'Ask for a window seat, then confirm.',
    };
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
    }).evaluateInvocations(invocations, undefined, scenario);
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
