/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests of `MultiTurnVertexAiEvalFacade`, ported from the
 * `TestMultiTurnVertexAiEvalFacade` cases of
 * `tests/unittests/evaluation/test_vertex_ai_eval_facade.py` at
 * `google/adk-python` commit `c7ef8cfa`.
 *
 * The reference calls the private static mappers directly. TypeScript has no
 * equivalent reach, so each case asserts the same mapping through the request
 * the fake client records.
 *
 * The reference `TestSingleTurnVertexAiEvalFacade` and `TestVertexAiEvalFacade`
 * cases are not ported. This branch carries no single-turn facade, and adk-js
 * injects the transport instead of building a client from the environment, so
 * there is no constructor to test.
 */

import {
  AgentDetails,
  ConversationScenario,
  EvalStatus,
  IntermediateDataType,
  Invocation,
  MultiTurnVertexAiEvalFacade,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {Tool} from '@google/genai';
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
    intermediateData: options.intermediateData,
    appDetails: options.agentDetails
      ? {agentDetails: options.agentDetails}
      : undefined,
  };
}

const TOOLS: Tool[] = [
  {functionDeclarations: [{name: 'tool_1', description: 'this is tool 1'}]},
];

const SCENARIO: ConversationScenario = {
  startingPrompt: 'book me a table',
  conversationPlan: 'ask for a table, then change the time',
};

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

function facadeWith(
  client: VertexAiEvalClient,
  threshold = 0.8,
): MultiTurnVertexAiEvalFacade {
  return new MultiTurnVertexAiEvalFacade({
    threshold,
    metricName: 'CONVERSATIONAL_COHERENCE',
    client,
  });
}

/** Returns the agent data of the only eval case of the recorded request. */
function agentDataOf(client: FakeEvalClient) {
  return client.requests[0].dataset.evalCases[0].agentData;
}

describe('MultiTurnVertexAiEvalFacade', () => {
  it('test_map_agent_details_to_agent_config', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await facadeWith(client).evaluateInvocations([
      turn({
        id: 'inv1',
        query: 'q1',
        response: 'r1',
        agentDetails: {
          test_agent: {
            name: 'test_agent',
            instructions: 'test_instructions',
            toolDeclarations: TOOLS,
          },
        },
      }),
    ]);

    expect(agentDataOf(client).agents).toEqual({
      test_agent: {
        agentId: 'test_agent',
        instruction: 'test_instructions',
        tools: TOOLS,
      },
    });
  });

  it('test_get_agent_details', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await facadeWith(client).evaluateInvocations([
      turn({
        id: 'inv1',
        query: 'q1',
        response: 'r1',
        agentDetails: {
          agent1: {name: 'agent1', instructions: 'instructions1'},
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
    ]);

    const agents = agentDataOf(client).agents;
    expect(Object.keys(agents)).toEqual(['agent1', 'agent2', 'agent3']);
    // An agent declared by several turns is described by the first of them.
    expect(agents['agent1'].instruction).toBe('instructions1');
    expect(agents['agent2'].instruction).toBe('instructions2');
    expect(agents['agent3'].instruction).toBe('instructions3');
  });

  it('test_map_invocation_event_to_agent_event', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await facadeWith(client).evaluateInvocations([
      turn({
        id: 'inv1',
        query: 'q1',
        response: 'r1',
        intermediateData: {
          invocationEvents: [
            {
              author: 'test_author',
              content: {parts: [{text: 'test_content'}]},
            },
          ],
        },
      }),
    ]);

    expect(agentDataOf(client).turns[0].events[1]).toEqual({
      author: 'test_author',
      content: {parts: [{text: 'test_content'}]},
    });
  });

  it('test_map_invocation_turn', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await facadeWith(client).evaluateInvocations([
      turn({
        id: 'inv1',
        query: 'user query',
        response: 'final response',
        intermediateData: {
          invocationEvents: [
            {
              author: 'agent1',
              content: {parts: [{text: 'intermediate content'}]},
            },
          ],
        },
      }),
    ]);

    const conversationTurn = agentDataOf(client).turns[0];
    expect(conversationTurn.turnIndex).toBe(0);
    expect(conversationTurn.turnId).toBe('inv1');
    expect(conversationTurn.events).toEqual([
      {author: 'user', content: {parts: [{text: 'user query'}]}},
      {author: 'agent1', content: {parts: [{text: 'intermediate content'}]}},
      {author: 'agent', content: {parts: [{text: 'final response'}]}},
    ]);
  });

  it('test_get_turns', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await facadeWith(client).evaluateInvocations(conversation());

    const turns = agentDataOf(client).turns;
    expect(turns.map((t) => t.turnId)).toEqual(['inv1', 'inv2']);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1]);
  });

  it('test_get_agent_data', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await facadeWith(client).evaluateInvocations([
      turn({
        id: 'inv1',
        query: 'q1',
        response: 'r1',
        intermediateData: {invocationEvents: []},
        agentDetails: {agent1: {name: 'agent1', instructions: 'instructions1'}},
      }),
    ]);

    const agentData = agentDataOf(client);
    expect(Object.keys(agentData.agents)).toEqual(['agent1']);
    expect(agentData.turns).toHaveLength(1);
  });

  it('test_evaluate_invocations_multi_turn_metric_passed', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result = await facadeWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBe(0.9);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.PASSED);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].metrics).toEqual([
      {name: 'CONVERSATIONAL_COHERENCE'},
    ]);
    const agentData = agentDataOf(client);
    expect(Object.keys(agentData.agents)).toEqual(['agent1']);
    expect(agentData.turns.map((t) => t.turnId)).toEqual(['inv1', 'inv2']);
    // user, intermediate, agent
    expect(agentData.turns[1].events).toHaveLength(3);
  });

  it('fails the last turn when the score is below the threshold', async () => {
    const client = new FakeEvalClient([scored(0.5)]);

    const result = await facadeWith(client).evaluateInvocations(conversation());

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.FAILED);
  });

  it('reports nothing at all when the service returns no score', async () => {
    for (const unscored of [{}, {summaryMetrics: []}, scored(Number.NaN)]) {
      const client = new FakeEvalClient([unscored]);

      const result =
        await facadeWith(client).evaluateInvocations(conversation());

      // Parity with adk-python: the per-invocation results are discarded.
      expect(result).toEqual({
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      });
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
      facadeWith(client).evaluateInvocations(
        [],
        [turn({id: 'golden1', query: 'q', response: 'a'})],
      ),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length;' +
        ' got 0 and 1.',
    );
    expect(client.requests).toHaveLength(0);
  });

  it('pairs every turn with its golden invocation', async () => {
    const client = new FakeEvalClient([scored(0.9)]);
    const expected = [
      turn({id: 'golden1', query: 'q1', response: 'golden1'}),
      turn({id: 'golden2', query: 'q2', response: 'golden2'}),
    ];

    const result = await facadeWith(client).evaluateInvocations(
      conversation(),
      expected,
    );

    expect(
      result.perInvocationResults.map((r) => r.expectedInvocation),
    ).toEqual(expected);
  });

  it('leaves the golden invocations undefined when none are given', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    const result = await facadeWith(client).evaluateInvocations(conversation());

    expect(
      result.perInvocationResults.map((r) => r.expectedInvocation),
    ).toEqual([undefined, undefined]);
  });

  it('collects no agents from turns that declare none', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await facadeWith(client).evaluateInvocations([
      turn({id: 'inv1', query: 'q1', response: 'r1'}),
      {...turn({id: 'inv2', query: 'q2', response: 'r2'}), appDetails: {}},
    ]);

    expect(agentDataOf(client).agents).toEqual({});
  });

  it('takes no intermediate events from recorded intermediate data', async () => {
    const client = new FakeEvalClient([scored(0.9)]);

    await facadeWith(client).evaluateInvocations([
      turn({
        id: 'inv1',
        query: 'q1',
        response: 'r1',
        intermediateData: {
          toolUses: [{name: 'tool_1', args: {}}],
          toolResponses: [{name: 'tool_1', response: {}}],
          intermediateResponses: [['agent1', [{text: 'thinking'}]]],
        },
      }),
      turn({id: 'inv2', query: 'q2', response: 'r2'}),
    ]);

    const turns = agentDataOf(client).turns;
    expect(turns[0].events).toEqual([
      {author: 'user', content: {parts: [{text: 'q1'}]}},
      {author: 'agent', content: {parts: [{text: 'r1'}]}},
    ]);
    expect(turns[1].events).toHaveLength(2);
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
