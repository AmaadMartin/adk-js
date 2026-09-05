/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentDetails,
  ConversationScenario,
  EvalStatus,
  IntermediateDataType,
  Invocation,
  MultiTurnVertexAiEvalFacade,
  resolveVertexAiEvalClientConfig,
  SingleTurnVertexAiEvalFacade,
  VertexAiEvalClient,
  VertexAiEvalRequest,
  VertexEvaluationResult,
} from '@google/adk';
import {Tool} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

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

describe('SingleTurnVertexAiEvalFacade', () => {
  it('rejects a call without expected invocations when the metric needs them', async () => {
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 0.5,
      metricName: 'COHERENCE',
      expectedInvocationsRequired: true,
      client: new FakeEvalClient([]),
    });

    await expect(
      facade.evaluateInvocations([invocation('q', 'a')]),
    ).rejects.toThrow('expectedInvocations is needed by this metric.');
  });

  it('rejects invocation lists of different lengths', async () => {
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 0.5,
      metricName: 'COHERENCE',
      client: new FakeEvalClient([]),
    });

    await expect(
      facade.evaluateInvocations(
        [invocation('q', 'a')],
        [invocation('q', 'a'), invocation('q2', 'a2')],
      ),
    ).rejects.toThrow(
      'actualInvocations and expectedInvocations must have the same length; got 1 and 2.',
    );
  });

  it('sends one request per invocation, with the metric name', async () => {
    const client = new FakeEvalClient([scored(4), scored(2)]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations(
      [invocation('q1', 'a1'), invocation('q2', 'a2')],
      [invocation('q1', 'golden1'), invocation('q2', 'golden2')],
    );

    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]).toEqual({
      dataset: {
        evalDataset: [{prompt: 'q1', reference: 'golden1', response: 'a1'}],
      },
      metrics: [{name: 'COHERENCE'}],
    });
    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.PASSED,
      EvalStatus.FAILED,
    ]);
    expect(result.overallScore).toBe(3);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('omits the reference when no expected invocations are given', async () => {
    const client = new FakeEvalClient([scored(4)]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations([
      invocation('what is the capital of France?', 'Paris.'),
    ]);

    expect(client.requests[0].dataset.evalDataset?.[0]).toEqual({
      prompt: 'what is the capital of France?',
      reference: undefined,
      response: 'Paris.',
    });
    expect(result.perInvocationResults[0].expectedInvocation).toBeUndefined();
  });

  it('does not score an invocation whose mean score is not a finite number', async () => {
    const client = new FakeEvalClient([
      scored(Number.NaN),
      scored(Number.POSITIVE_INFINITY),
      {summaryMetrics: []},
      {},
    ]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations([
      invocation('q1', 'a1'),
      invocation('q2', 'a2'),
      invocation('q3', 'a3'),
      invocation('q4', 'a4'),
    ]);

    expect(result.perInvocationResults.map((r) => r.score)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toHaveLength(4);
  });

  it('averages over the scored invocations only', async () => {
    const client = new FakeEvalClient([
      scored(4),
      {summaryMetrics: []},
      scored(2),
    ]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations([
      invocation('q1', 'a1'),
      invocation('q2', 'a2'),
      invocation('q3', 'a3'),
    ]);

    expect(result.overallScore).toBe(3);
    expect(result.perInvocationResults.map((r) => r.evalStatus)).toEqual([
      EvalStatus.PASSED,
      EvalStatus.NOT_EVALUATED,
      EvalStatus.FAILED,
    ]);
  });

  it('returns an unevaluated result for empty invocation lists', async () => {
    const client = new FakeEvalClient([]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations([], []);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(client.requests).toHaveLength(0);
  });

  it('sends an empty string for content that carries no text', async () => {
    const client = new FakeEvalClient([scored(4)]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    await facade.evaluateInvocations([
      {
        invocationId: 'inv1',
        userContent: {parts: [{functionCall: {name: 'tool_1', args: {}}}]},
        finalResponse: {},
        creationTimestamp: 0,
      },
    ]);

    expect(client.requests[0].dataset.evalDataset?.[0]).toEqual({
      prompt: '',
      reference: undefined,
      response: '',
    });
  });

  it('accepts and ignores a conversation scenario', async () => {
    const client = new FakeEvalClient([scored(4)]);
    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 3,
      metricName: 'COHERENCE',
      client,
    });

    const result = await facade.evaluateInvocations(
      [invocation('q1', 'a1')],
      undefined,
      SCENARIO,
    );

    expect(client.requests[0]).toEqual({
      dataset: {
        evalDataset: [{prompt: 'q1', reference: undefined, response: 'a1'}],
      },
      metrics: [{name: 'COHERENCE'}],
    });
    expect(result.overallScore).toBe(4);
  });
});

describe('resolveVertexAiEvalClientConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Stubs the three variables the configuration reads, and only those. */
  function stubEnvironment(values: {
    apiKey?: string;
    project?: string;
    location?: string;
  }): void {
    vi.stubEnv('GOOGLE_API_KEY', values.apiKey);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', values.project);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', values.location);
  }

  it('reads the API key', () => {
    stubEnvironment({apiKey: 'test_api_key'});

    expect(resolveVertexAiEvalClientConfig()).toEqual({
      apiKey: 'test_api_key',
    });
  });

  it('reads the project and the location', () => {
    stubEnvironment({project: 'test_project', location: 'test_location'});

    expect(resolveVertexAiEvalClientConfig()).toEqual({
      project: 'test_project',
      location: 'test_location',
    });
  });

  it('rejects a project without a location', () => {
    stubEnvironment({project: 'test_project'});

    expect(() => resolveVertexAiEvalClientConfig()).toThrow(
      /^Missing location\./,
    );
  });

  it('rejects a location without a project', () => {
    stubEnvironment({location: 'test_location'});

    expect(() => resolveVertexAiEvalClientConfig()).toThrow(
      /^Missing project id\./,
    );
  });

  it('rejects an environment that configures nothing', () => {
    stubEnvironment({});

    expect(() => resolveVertexAiEvalClientConfig()).toThrow(
      'Either API Key or Google cloud Project id and location should be specified.',
    );
  });

  it('prefers the API key over the project and the location', () => {
    stubEnvironment({
      apiKey: 'test_api_key',
      project: 'test_project',
      location: 'test_location',
    });

    expect(resolveVertexAiEvalClientConfig()).toEqual({
      apiKey: 'test_api_key',
    });
  });

  it('reads an empty value as an absent one', () => {
    stubEnvironment({
      apiKey: '',
      project: 'test_project',
      location: 'test_location',
    });

    expect(resolveVertexAiEvalClientConfig()).toEqual({
      project: 'test_project',
      location: 'test_location',
    });
  });

  it('constructs a facade without reading the environment', () => {
    stubEnvironment({});

    const facade = new SingleTurnVertexAiEvalFacade({
      threshold: 0.8,
      metricName: 'COHERENCE',
      client: new FakeEvalClient([]),
    });

    expect(facade).toBeInstanceOf(SingleTurnVertexAiEvalFacade);
  });

  it('resolves the configuration from the environment it is given', () => {
    stubEnvironment({});

    expect(
      resolveVertexAiEvalClientConfig({GOOGLE_API_KEY: 'explicit_api_key'}),
    ).toEqual({apiKey: 'explicit_api_key'});
  });
});

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
      metricName: 'CONVERSATIONAL_COHERENCE',
      client,
    });
  }

  it('scores the conversation with one request, and marks the earlier turns unevaluated', async () => {
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
      {name: 'CONVERSATIONAL_COHERENCE'},
    ]);
    const evalCases = client.requests[0].dataset.evalCases;
    expect(evalCases).toHaveLength(1);
    const agentData = evalCases?.[0].agentData;
    expect(Object.keys(agentData?.agents ?? {})).toEqual(['agent1']);
    expect(agentData?.turns).toHaveLength(2);
    expect(agentData?.turns.map((t) => t.turnId)).toEqual(['inv1', 'inv2']);
    expect(agentData?.turns.map((t) => t.turnIndex)).toEqual([0, 1]);
    expect(agentData?.turns[1].events).toEqual([
      {author: 'user', content: {parts: [{text: 'q2'}]}},
      {author: 'agent1', content: {parts: [{text: 'intermediate 1'}]}},
      {author: 'agent2', content: {parts: [{text: 'intermediate 2'}]}},
      {author: 'agent', content: {parts: [{text: 'r2'}]}},
    ]);
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

    expect(client.requests[0].dataset.evalCases?.[0].agentData.agents).toEqual({
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

    expect(client.requests[0].dataset.evalCases?.[0].agentData.agents).toEqual(
      {},
    );
  });

  it('takes no intermediate events from recorded intermediate data', async () => {
    const client = new FakeEvalClient([scored(0.9)]);
    const invocations = [
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
    ];

    await facadeWith(client).evaluateInvocations(invocations);

    const turns = client.requests[0].dataset.evalCases?.[0].agentData.turns;
    expect(turns?.[0].events).toEqual([
      {author: 'user', content: {parts: [{text: 'q1'}]}},
      {author: 'agent', content: {parts: [{text: 'r1'}]}},
    ]);
    expect(turns?.[1].events).toHaveLength(2);
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

  it('scores a conversation even when the metric declares golden invocations required', async () => {
    // The reference checks expectedInvocationsRequired in the single-turn
    // facade only, so a multi-turn metric scores without golden invocations.
    const client = new FakeEvalClient([scored(0.9)]);
    const facade = new MultiTurnVertexAiEvalFacade({
      threshold: 0.8,
      metricName: 'CONVERSATIONAL_COHERENCE',
      expectedInvocationsRequired: true,
      client,
    });

    const result = await facade.evaluateInvocations(conversation());

    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });
});
