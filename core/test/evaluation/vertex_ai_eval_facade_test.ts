/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentDetails,
  ConversationScenario,
  EvalStatus,
  Invocation,
  InvocationEvents,
  MultiTurnVertexAiEvalFacade,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

function invocation(query: string, response: string): Invocation {
  return {
    invocationId: '',
    userContent: {parts: [{text: query}]},
    finalResponse: {parts: [{text: response}]},
    creationTimestamp: 0,
  };
}

/** One turn of a conversation, with the fields a multi-turn request maps. */
function turn(options: {
  id: string;
  query: string;
  response: string;
  intermediateData?: InvocationEvents;
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

describe('MultiTurnVertexAiEvalFacade', () => {
  const TOOLS: Tool[] = [
    {
      functionDeclarations: [{name: 'tool_1', description: 'this is tool 1'}],
    },
  ];

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
            {author: 'agent1', content: {parts: [{text: 'intermediate 1'}]}},
            {author: 'agent2', content: {parts: [{text: 'intermediate 2'}]}},
          ],
        },
        agentDetails: {agent1: {name: 'agent1', instructions: 'instructions1'}},
      }),
    ];
  }

  function facadeWith(
    client: VertexAiEvalClient,
    threshold = 0.8,
  ): MultiTurnVertexAiEvalFacade {
    return new MultiTurnVertexAiEvalFacade({
      threshold,
      metricName: 'MULTI_TURN_TRAJECTORY_QUALITY',
      client,
    });
  }

  it('test_evaluate_invocations_multi_turn_metric_passed', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result = await facadeWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[1].score).toBe(0.9);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.PASSED);

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].metrics).toEqual([
      {name: 'MULTI_TURN_TRAJECTORY_QUALITY'},
    ]);
    const evalCases = client.requests[0].dataset.evalCases;
    expect(evalCases).toHaveLength(1);
    const agentData = evalCases[0].agentData;
    expect(Object.keys(agentData.agents)).toEqual(['agent1']);
    expect(agentData.turns).toHaveLength(2);
    expect(
      agentData.turns.map((conversationTurn) => conversationTurn.turnId),
    ).toEqual(['inv1', 'inv2']);
    expect(
      agentData.turns.map((conversationTurn) => conversationTurn.turnIndex),
    ).toEqual([0, 1]);
    expect(agentData.turns[1].events).toEqual([
      {author: 'user', content: {parts: [{text: 'q2'}]}},
      {author: 'agent1', content: {parts: [{text: 'intermediate 1'}]}},
      {author: 'agent2', content: {parts: [{text: 'intermediate 2'}]}},
      {author: 'agent', content: {parts: [{text: 'r2'}]}},
    ]);
  });

  it('passes a conversation scored exactly at the threshold', async () => {
    const client = new FakeEvalClient([scored(0.8)]);

    const result = await facadeWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBe(0.8);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails the last turn when the score is below the threshold', async () => {
    const client = new FakeEvalClient([scored(0.5)]);

    const result = await facadeWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('reports nothing at all when the service returns no score', async () => {
    for (const unscored of [{summaryMetrics: []}, scored(Number.NaN)]) {
      const client = new FakeEvalClient([unscored]);

      const result =
        await facadeWith(client).evaluateInvocations(conversation());

      // Parity with adk-python: the per-invocation results are discarded.
      expect(result).toEqual({
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      });
      expect(result.overallScore).toBeUndefined();
      expect(client.requests).toHaveLength(1);
    }
  });

  it('sends no request for an empty conversation', async () => {
    const client = new FakeEvalClient([]);

    const result = await facadeWith(client).evaluateInvocations([]);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(client.requests).toHaveLength(0);
  });

  it('rejects invocation lists of different lengths before the empty check', async () => {
    const client = new FakeEvalClient([]);

    await expect(
      facadeWith(client).evaluateInvocations([], [invocation('q', 'a')]),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length; got 0 and 1.',
    );
    expect(client.requests).toHaveLength(0);
  });

  it('pairs every turn with its golden invocation', async () => {
    const client = new FakeEvalClient([scored(0.9)]);
    const expected = [invocation('q1', 'golden1'), invocation('q2', 'golden2')];

    const result = await facadeWith(client).evaluateInvocations(
      conversation(),
      expected,
    );

    expect(
      result.perInvocationResults.map(
        (perInvocation) => perInvocation.expectedInvocation,
      ),
    ).toEqual(expected);
  });

  it('leaves the golden invocations undefined when none are given', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result = await facadeWith(client).evaluateInvocations(conversation());

    expect(
      result.perInvocationResults.map(
        (perInvocation) => perInvocation.expectedInvocation,
      ),
    ).toEqual([undefined, undefined]);
  });

  it('describes an agent by the first turn that declares it', async () => {
    const client = new FakeEvalClient([scored(0.9)]);
    const invocations = [
      turn({
        id: 'inv1',
        query: 'q1',
        response: 'r1',
        agentDetails: {
          agent1: {
            name: 'agent1',
            instructions: 'instructions1',
            toolDeclarations: TOOLS,
          },
          agent2: {name: 'agent2', instructions: 'instructions2'},
        },
      }),
      turn({
        id: 'inv2',
        query: 'q2',
        response: 'r2',
        agentDetails: {
          agent1: {name: 'agent1', instructions: 'a later instruction'},
          agent3: {name: 'agent3', instructions: 'instructions3'},
        },
      }),
    ];

    await facadeWith(client).evaluateInvocations(invocations);

    expect(client.requests[0].dataset.evalCases[0].agentData.agents).toEqual({
      agent1: {
        agentId: 'agent1',
        instruction: 'instructions1',
        tools: TOOLS,
      },
      agent2: {
        agentId: 'agent2',
        instruction: 'instructions2',
        tools: undefined,
      },
      agent3: {
        agentId: 'agent3',
        instruction: 'instructions3',
        tools: undefined,
      },
    });
  });

  it('collects no agents from turns that declare none', async () => {
    const client = new FakeEvalClient([scored(0.9)]);
    const invocations = [
      turn({id: 'inv1', query: 'q1', response: 'r1'}),
      {...turn({id: 'inv2', query: 'q2', response: 'r2'}), appDetails: {}},
    ];

    await facadeWith(client).evaluateInvocations(invocations);

    expect(client.requests[0].dataset.evalCases[0].agentData.agents).toEqual(
      {},
    );
  });

  it('accepts and ignores a conversation scenario', async () => {
    const withScenario = new FakeEvalClient([scored(0.9)]);
    const withoutScenario = new FakeEvalClient([scored(0.9)]);

    await facadeWith(withScenario).evaluateInvocations(
      conversation(),
      undefined,
      SCENARIO,
    );
    await facadeWith(withoutScenario).evaluateInvocations(conversation());

    expect(withScenario.requests).toEqual(withoutScenario.requests);
  });
});
