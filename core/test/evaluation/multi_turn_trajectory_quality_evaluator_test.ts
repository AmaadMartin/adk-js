/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  MultiTurnTrajectoryQualityV1Evaluator,
  PrebuiltMetrics,
  type ConversationScenario,
  type Invocation,
  type VertexAiEvalClient,
  type VertexAiEvalRequest,
  type VertexEvaluationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

describe('MultiTurnTrajectoryQualityV1Evaluator', () => {
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

  it('forwards a conversation scenario without altering the request', async () => {
    const scenario: ConversationScenario = {
      startingPrompt: 'Book me a flight.',
      conversationPlan: 'Book a one-way flight from SFO to LAX.',
    };
    const withScenario = new FakeEvalClient([scored(0.9)]);
    const withoutScenario = new FakeEvalClient([scored(0.9)]);
    const evalMetric = {
      metricName: PrebuiltMetrics.MULTI_TURN_TRAJECTORY_QUALITY_V1,
      threshold: 0.8,
    };

    const result = await new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric,
      evalClient: withScenario,
    }).evaluateInvocations([invocation('q', 'a')], undefined, scenario);
    await new MultiTurnTrajectoryQualityV1Evaluator({
      evalMetric,
      evalClient: withoutScenario,
    }).evaluateInvocations([invocation('q', 'a')]);

    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(withScenario.requests).toEqual(withoutScenario.requests);
  });
});
