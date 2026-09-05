/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ports tests/unittests/evaluation/test_multi_turn_task_success_evaluator.py
// of google/adk-python.

import {afterEach, describe, expect, it, vi} from 'vitest';
import type {
  AgentDetails,
  ConversationScenario,
  EvalMetric,
  IntermediateDataType,
  Invocation,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '../../src/index.js';
import {
  EvalStatus,
  MultiTurnTaskSuccessV1Evaluator,
  MultiTurnVertexAiEvalFacade,
  PrebuiltMetrics,
} from '../../src/index.js';

/** One turn of a conversation, with the fields a multi-turn request maps. */
function turn(options: {
  id: string;
  query: string;
  response: string;
  intermediateData?: IntermediateDataType;
  agentDetails?: Record<string, AgentDetails>;
}): Invocation {
  return {
    invocationId: options.id,
    userContent: {parts: [{text: options.query}]},
    finalResponse: {parts: [{text: options.response}]},
    creationTimestamp: 0,
    intermediateData: options.intermediateData,
    appDetails: options.agentDetails
      ? {agentDetails: options.agentDetails}
      : undefined,
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

const SCENARIO: ConversationScenario = {
  startingPrompt: 'book me a table',
  conversationPlan: 'ask for a table, then change the time',
};

/** The two-turn conversation the reference test scores. */
function conversation(): Invocation[] {
  return [
    turn({
      id: 'inv1',
      query: 'q1',
      response: 'r1',
      intermediateData: {invocationEvents: []},
      agentDetails: {agent1: {name: 'agent1', instructions: 'instructions1'}},
    }),
    turn({
      id: 'inv2',
      query: 'q2',
      response: 'r2',
      intermediateData: {
        invocationEvents: [
          {author: 'agent1', content: {parts: [{text: 'intermediate'}]}},
        ],
      },
      agentDetails: {agent1: {name: 'agent1', instructions: 'instructions1'}},
    }),
  ];
}

function evaluatorWith(
  client: VertexAiEvalClient,
  evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
    threshold: 0.8,
  },
): MultiTurnTaskSuccessV1Evaluator {
  return new MultiTurnTaskSuccessV1Evaluator({evalMetric, evalClient: client});
}

describe('MultiTurnTaskSuccessV1Evaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Ports TestMultiTurnTaskSuccessV1Evaluator
  // ::test_evaluate_invocations_metric_passed
  it('scores a two-turn conversation and requests the MULTI_TURN_TASK_SUCCESS metric', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result =
      await evaluatorWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TASK_SUCCESS'},
    ]);
  });

  it('fails the conversation when the score is below the threshold', async () => {
    const client = new FakeEvalClient([scored(0.5)]);

    const result =
      await evaluatorWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('passes the conversation when the score exactly meets the threshold', async () => {
    const client = new FakeEvalClient([scored(0.8)]);

    const result =
      await evaluatorWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBe(0.8);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('reports nothing at all when the service returns no score', async () => {
    const client = new FakeEvalClient([{summaryMetrics: []}]);

    const result =
      await evaluatorWith(client).evaluateInvocations(conversation());

    // Parity with adk-python: the per-invocation results are discarded.
    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(client.requests).toHaveLength(1);
  });

  it('treats a mean score that is not a finite number as no score', async () => {
    const client = new FakeEvalClient([scored(Number.NaN)]);

    const result =
      await evaluatorWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('marks every turn but the last unevaluated, and scores the last one', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result =
      await evaluatorWith(client).evaluateInvocations(conversation());

    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[1].score).toBe(0.9);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('sends exactly one request for a three-turn conversation', async () => {
    const client = new FakeEvalClient([scored(0.9)]);
    const invocations = [
      ...conversation(),
      turn({id: 'inv3', query: 'q3', response: 'r3'}),
    ];

    const result = await evaluatorWith(client).evaluateInvocations(invocations);

    expect(client.requests).toHaveLength(1);
    expect(result.perInvocationResults).toHaveLength(3);
    expect(
      client.requests[0].dataset.evalCases?.[0].agentData.turns,
    ).toHaveLength(3);
  });

  it('reads the threshold from the criterion', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result = await evaluatorWith(client, {
      metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
      criterion: {threshold: 0.95},
    }).evaluateInvocations(conversation());

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('reads the deprecated metric-level threshold', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result = await evaluatorWith(client, {
      metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
      threshold: 0.95,
    }).evaluateInvocations(conversation());

    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('prefers the criterion threshold over the deprecated one', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result = await evaluatorWith(client, {
      metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
      threshold: 0.95,
      criterion: {threshold: 0.8},
    }).evaluateInvocations(conversation());

    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('rejects a metric that carries no threshold, before any request', () => {
    const client = new FakeEvalClient([scored(0.9)]);

    expect(
      () =>
        new MultiTurnTaskSuccessV1Evaluator({
          evalMetric: {
            metricName: PrebuiltMetrics.MULTI_TURN_TASK_SUCCESS_V1,
          },
          evalClient: client,
        }),
    ).toThrow(
      "Evaluation metric 'multi_turn_task_success_v1' requires a threshold.",
    );
    expect(client.requests).toHaveLength(0);
  });

  it('rejects invocation lists of different lengths, before any request', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await expect(
      evaluatorWith(client).evaluateInvocations(conversation(), [
        turn({id: 'golden1', query: 'q1', response: 'golden1'}),
      ]),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length; got 2 and 1.',
    );
    expect(client.requests).toHaveLength(0);
  });

  it('returns the empty result and sends no request for an empty conversation', async () => {
    const client = new FakeEvalClient([]);

    const result = await evaluatorWith(client).evaluateInvocations([]);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(client.requests).toHaveLength(0);
  });

  it('pairs each turn with its golden invocation, and leaves them undefined when none are given', async () => {
    const paired = new FakeEvalClient([scored(0.9)]);
    const unpaired = new FakeEvalClient([scored(0.9)]);
    const expected = [
      turn({id: 'golden1', query: 'q1', response: 'golden1'}),
      turn({id: 'golden2', query: 'q2', response: 'golden2'}),
    ];

    const withGolden = await evaluatorWith(paired).evaluateInvocations(
      conversation(),
      expected,
    );
    const withoutGolden =
      await evaluatorWith(unpaired).evaluateInvocations(conversation());

    expect(
      withGolden.perInvocationResults.map((r) => r.expectedInvocation),
    ).toEqual(expected);
    expect(
      withoutGolden.perInvocationResults.map((r) => r.expectedInvocation),
    ).toEqual([undefined, undefined]);
  });

  it('forwards the conversation scenario to the facade', async () => {
    const client = new FakeEvalClient([scored(0.9)]);
    const forwarded = vi.spyOn(
      MultiTurnVertexAiEvalFacade.prototype,
      'evaluateInvocations',
    );
    const invocations = conversation();

    await evaluatorWith(client).evaluateInvocations(
      invocations,
      undefined,
      SCENARIO,
    );

    expect(forwarded).toHaveBeenCalledWith(invocations, undefined, SCENARIO);
  });

  it('scores the same conversation with and without a scenario', async () => {
    const withScenario = new FakeEvalClient([scored(0.9)]);
    const withoutScenario = new FakeEvalClient([scored(0.9)]);

    const scenarioResult = await evaluatorWith(
      withScenario,
    ).evaluateInvocations(conversation(), undefined, SCENARIO);
    const plainResult =
      await evaluatorWith(withoutScenario).evaluateInvocations(conversation());

    expect(withScenario.requests).toEqual(withoutScenario.requests);
    expect(scenarioResult).toEqual(plainResult);
  });

  it('maps the conversation onto turns and collects the agents', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await evaluatorWith(client).evaluateInvocations(conversation());

    const agentData = client.requests[0].dataset.evalCases?.[0].agentData;
    expect(agentData?.agents).toEqual({
      agent1: {
        agentId: 'agent1',
        instruction: 'instructions1',
        tools: undefined,
      },
    });
    expect(agentData?.turns.map((t) => t.turnId)).toEqual(['inv1', 'inv2']);
    expect(agentData?.turns.map((t) => t.turnIndex)).toEqual([0, 1]);
    expect(agentData?.turns[0].events).toEqual([
      {author: 'user', content: {parts: [{text: 'q1'}]}},
      {author: 'agent', content: {parts: [{text: 'r1'}]}},
    ]);
    expect(agentData?.turns[1].events).toEqual([
      {author: 'user', content: {parts: [{text: 'q2'}]}},
      {author: 'agent1', content: {parts: [{text: 'intermediate'}]}},
      {author: 'agent', content: {parts: [{text: 'r2'}]}},
    ]);
  });

  it('lets an error from the client propagate unchanged', async () => {
    class FailingEvalClient implements VertexAiEvalClient {
      async evaluate(): Promise<VertexEvaluationResult> {
        throw new Error('the service is unreachable');
      }
    }

    await expect(
      evaluatorWith(new FailingEvalClient()).evaluateInvocations(
        conversation(),
      ),
    ).rejects.toThrow('the service is unreachable');
  });
});
