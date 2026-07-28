/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {BaseAgent} from '../../src/agents/base_agent.js';
import {InMemoryArtifactService} from '../../src/artifacts/in_memory_artifact_service.js';
import {AppDetails} from '../../src/evaluation/app_details.js';
import {
  getAllToolCalls,
  InvocationEvents,
} from '../../src/evaluation/eval_case.js';
import {EvaluationGenerator} from '../../src/evaluation/evaluation_generator.js';
import {RequestIntercepterPlugin} from '../../src/evaluation/request_intercepter_plugin.js';
import {
  NextUserMessage,
  Status,
  UserSimulator,
} from '../../src/evaluation/simulation/user_simulator.js';
import {createEvent, Event} from '../../src/events/event.js';
import {createEventActions} from '../../src/events/event_actions.js';
import {InMemoryMemoryService} from '../../src/memory/in_memory_memory_service.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';

function buildEvent(
  author: string,
  parts: Part[],
  invocationId: string,
  actions = createEventActions(),
): Event {
  return createEvent({author, content: {parts}, invocationId, actions});
}

function invocationEventsOf(event: {
  intermediateData?: unknown;
}): InvocationEvents {
  return event.intermediateData as InvocationEvents;
}

// `getAppDetailsByInvocationId` is a package-private static (it takes the
// internal RequestIntercepterPlugin); reach it for direct testing.
const generatorInternals = EvaluationGenerator as unknown as {
  getAppDetailsByInvocationId(
    events: Event[],
    requestIntercepter: RequestIntercepterPlugin,
  ): Record<string, AppDetails>;
};

describe('EvaluationGenerator.convertEventsToEvalInvocations', () => {
  it('returns an empty list for no events', () => {
    expect(EvaluationGenerator.convertEventsToEvalInvocations([])).toEqual([]);
  });

  it('converts a single text-only turn', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1'),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    expect(invocations[0].invocationId).toBe('inv1');
    expect(invocations[0].userContent.parts?.[0].text).toBe('Hello');
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('Hi there!');
    expect(invocationEventsOf(invocations[0]).invocationEvents).toHaveLength(0);
  });

  it('converts a single turn with a tool call', () => {
    const events = [
      buildEvent('user', [{text: 'what is the weather?'}], 'inv1'),
      buildEvent(
        'agent',
        [{functionCall: {name: 'get_weather', args: {}}}],
        'inv1',
      ),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    expect(invocations[0].finalResponse).toBeUndefined();
    const intermediate = invocationEventsOf(invocations[0]).invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].author).toBe('agent');
    expect(intermediate[0].content?.parts?.[0].functionCall?.name).toBe(
      'get_weather',
    );
  });

  it('converts a turn with a tool call and a final text response', () => {
    const events = [
      buildEvent('user', [{text: 'what is the weather?'}], 'inv1'),
      buildEvent(
        'agent',
        [{functionCall: {name: 'get_weather', args: {}}}],
        'inv1',
      ),
      buildEvent('agent', [{text: 'It is sunny in SF.'}], 'inv1'),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations[0].finalResponse?.parts?.[0].text).toBe(
      'It is sunny in SF.',
    );
    const intermediate = invocationEventsOf(invocations[0]).invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].content?.parts?.[0].functionCall?.name).toBe(
      'get_weather',
    );
  });

  it('handles multiple turns', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1'),
      buildEvent('user', [{text: 'How are you?'}], 'inv2'),
      buildEvent('agent', [{text: 'I am fine.'}], 'inv2'),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(2);
    expect(invocations[0].userContent.parts?.[0].text).toBe('Hello');
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('Hi there!');
    expect(invocations[1].userContent.parts?.[0].text).toBe('How are you?');
    expect(invocations[1].finalResponse?.parts?.[0].text).toBe('I am fine.');
  });

  it('captures the route in a multi-agent scenario', () => {
    const events = [
      buildEvent('user', [{text: 'Do something'}], 'inv1'),
      buildEvent(
        'root_agent',
        [{functionCall: {name: 'tool1', args: {}}}],
        'inv1',
      ),
      buildEvent(
        'sub_agent_1',
        [{functionCall: {name: 'tool2', args: {}}}],
        'inv1',
      ),
      buildEvent(
        'sub_agent_1',
        [
          {functionCall: {name: 'tool3', args: {}}},
          {text: 'intermediate response'},
        ],
        'inv1',
      ),
      buildEvent(
        'sub_agent_2',
        [{functionCall: {name: 'tool4', args: {}}}],
        'inv1',
      ),
      buildEvent('root_agent', [{text: 'All done.'}], 'inv1'),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('All done.');
    const intermediate = invocationEventsOf(invocations[0]).invocationEvents;
    expect(intermediate.map((event) => event.author)).toEqual([
      'root_agent',
      'sub_agent_1',
      'sub_agent_1',
      'sub_agent_2',
    ]);
  });

  it('excludes only the last final response from intermediate data', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent1', [{text: 'First response'}], 'inv1'),
      buildEvent('agent2', [{text: 'Second response'}], 'inv1'),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations[0].finalResponse?.parts?.[0].text).toBe(
      'Second response',
    );
    const intermediate = invocationEventsOf(invocations[0]).invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].author).toBe('agent1');
    expect(intermediate[0].content?.parts?.[0].text).toBe('First response');
  });

  it('preserves tool calls when skip summarization is set', () => {
    const events = [
      buildEvent('user', [{text: 'run a query'}], 'inv1'),
      buildEvent(
        'agent',
        [
          {
            functionCall: {
              id: 'call_01',
              name: 'execute_sql',
              args: {projectId: 'my-proj', query: 'SELECT 1'},
            },
          },
        ],
        'inv1',
        createEventActions({skipSummarization: true}),
      ),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    const toolCalls = getAllToolCalls(invocations[0].intermediateData);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('execute_sql');
  });

  it('ignores a non-user event with no qualifying parts', () => {
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{thought: true}], 'inv1'),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    // The thought-only agent event is a final response (no tool calls/text),
    // but it carries no qualifying parts so it is not added to intermediate
    // data.
    expect(invocationEventsOf(invocations[0]).invocationEvents).toHaveLength(0);
  });

  it('falls back to a default author and empty user content', () => {
    const events = [
      // A user event with no content leaves userContent at its default.
      createEvent({author: 'user', invocationId: 'inv1'}),
      // An authorless event is treated as the default author.
      createEvent({content: {parts: [{text: 'hi'}]}, invocationId: 'inv1'}),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations).toHaveLength(1);
    expect(invocations[0].userContent).toEqual({parts: []});
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('hi');
  });

  it('uses the default author for authorless intermediate events', () => {
    const events = [
      buildEvent('user', [{text: 'hi'}], 'inv1'),
      // Authorless tool-call event -> intermediate, default author.
      createEvent({
        content: {parts: [{functionCall: {name: 'tool', args: {}}}]},
        invocationId: 'inv1',
      }),
      // Authorless final text event.
      createEvent({content: {parts: [{text: 'done'}]}, invocationId: 'inv1'}),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    const intermediate = invocationEventsOf(invocations[0]).invocationEvents;
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0].author).toBe('agent');
  });

  it('skips a non-user event with no content', () => {
    const events = [
      buildEvent('user', [{text: 'hi'}], 'inv1'),
      createEvent({author: 'agent', invocationId: 'inv1'}),
      buildEvent('agent', [{text: 'done'}], 'inv1'),
    ];

    const invocations =
      EvaluationGenerator.convertEventsToEvalInvocations(events);

    expect(invocations[0].finalResponse?.parts?.[0].text).toBe('done');
    expect(invocationEventsOf(invocations[0]).invocationEvents).toHaveLength(0);
  });
});

describe('EvaluationGenerator.getAppDetailsByInvocationId', () => {
  function mockIntercepter(): RequestIntercepterPlugin {
    return {getModelRequest: vi.fn()} as unknown as RequestIntercepterPlugin;
  }

  it('returns an empty record for no events', () => {
    const requestIntercepter = mockIntercepter();
    expect(
      generatorInternals.getAppDetailsByInvocationId([], requestIntercepter),
    ).toEqual({});
  });

  it('creates an empty AppDetails when there are no model requests', () => {
    const requestIntercepter = mockIntercepter();
    vi.mocked(requestIntercepter.getModelRequest).mockReturnValue(undefined);
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1'),
    ];

    const appDetails = generatorInternals.getAppDetailsByInvocationId(
      events,
      requestIntercepter,
    );

    expect(appDetails).toEqual({inv1: {agentDetails: {}}});
    expect(requestIntercepter.getModelRequest).toHaveBeenCalledTimes(1);
    expect(requestIntercepter.getModelRequest).toHaveBeenCalledWith(events[1]);
  });

  it('captures details for a single agent', () => {
    const requestIntercepter = mockIntercepter();
    const llmRequest: LlmRequest = {
      model: 'test',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'instruction1', tools: [{}]},
    };
    vi.mocked(requestIntercepter.getModelRequest).mockReturnValue(llmRequest);
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1'),
    ];

    const appDetails = generatorInternals.getAppDetailsByInvocationId(
      events,
      requestIntercepter,
    );

    expect(appDetails).toEqual({
      inv1: {
        agentDetails: {
          agent: {
            name: 'agent',
            instructions: 'instruction1',
            toolDeclarations: [{}],
          },
        },
      },
    });
  });

  it('captures details across invocations and agents', () => {
    const requestIntercepter = mockIntercepter();
    vi.mocked(requestIntercepter.getModelRequest).mockImplementation(
      (llmResponse) => {
        const event = llmResponse as Event;
        if (event.invocationId === 'inv1' && event.author === 'agent1') {
          return {
            model: 'test',
            contents: [],
            toolsDict: {},
            liveConnectConfig: {},
            config: {
              systemInstruction: 'instruction1',
              tools: [{functionDeclarations: [{name: 'tool1'}]}],
            },
          } as LlmRequest;
        }
        if (event.invocationId === 'inv2' && event.author === 'agent2') {
          return {
            model: 'test',
            contents: [],
            toolsDict: {},
            liveConnectConfig: {},
            config: {systemInstruction: 'instruction2'},
          } as LlmRequest;
        }
        return undefined;
      },
    );
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent1', [{text: 'Hi there!'}], 'inv1'),
      buildEvent('user', [{text: 'Hello again'}], 'inv2'),
      buildEvent('agent2', [{text: 'Hi again!'}], 'inv2'),
      buildEvent('agent1', [{text: 'Hi again from agent1'}], 'inv2'),
    ];

    const appDetails = generatorInternals.getAppDetailsByInvocationId(
      events,
      requestIntercepter,
    );

    expect(appDetails).toEqual({
      inv1: {
        agentDetails: {
          agent1: {
            name: 'agent1',
            instructions: 'instruction1',
            toolDeclarations: [{functionDeclarations: [{name: 'tool1'}]}],
          },
        },
      },
      inv2: {
        agentDetails: {
          agent2: {
            name: 'agent2',
            instructions: 'instruction2',
            toolDeclarations: [],
          },
        },
      },
    });
    expect(requestIntercepter.getModelRequest).toHaveBeenCalledTimes(3);
  });

  it('defaults instructions and tools when the request has no config', () => {
    const requestIntercepter = mockIntercepter();
    vi.mocked(requestIntercepter.getModelRequest).mockReturnValue({
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    });
    const events = [
      buildEvent('user', [{text: 'Hello'}], 'inv1'),
      buildEvent('agent', [{text: 'Hi there!'}], 'inv1'),
    ];

    const appDetails = generatorInternals.getAppDetailsByInvocationId(
      events,
      requestIntercepter,
    );

    expect(appDetails).toEqual({
      inv1: {
        agentDetails: {
          agent: {name: 'agent', instructions: '', toolDeclarations: []},
        },
      },
    });
  });

  it('skips authorless non-user events', () => {
    const requestIntercepter = mockIntercepter();
    vi.mocked(requestIntercepter.getModelRequest).mockReturnValue({
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'instruction'},
    });
    const events = [
      createEvent({content: {parts: [{text: 'x'}]}, invocationId: 'inv1'}),
    ];

    const appDetails = generatorInternals.getAppDetailsByInvocationId(
      events,
      requestIntercepter,
    );

    expect(appDetails).toEqual({inv1: {agentDetails: {}}});
  });

  it('records an agent at most once per invocation', () => {
    const requestIntercepter = mockIntercepter();
    vi.mocked(requestIntercepter.getModelRequest).mockReturnValue({
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {systemInstruction: 'first'},
    });
    const events = [
      buildEvent('agent', [{text: 'a'}], 'inv1'),
      buildEvent('agent', [{text: 'b'}], 'inv1'),
    ];

    const appDetails = generatorInternals.getAppDetailsByInvocationId(
      events,
      requestIntercepter,
    );

    expect(Object.keys(appDetails['inv1'].agentDetails)).toEqual(['agent']);
    expect(appDetails['inv1'].agentDetails['agent'].instructions).toBe('first');
  });
});

describe('EvaluationGenerator.generateInferencesForSingleUserInvocation', () => {
  it('prefixes a synthetic user event and yields agent events', async () => {
    const agentParts: Part[] = [{text: 'Agent response'}];
    async function* mockRunAsync(): AsyncGenerator<Event> {
      yield buildEvent('agent', agentParts, 'inv1');
    }
    const runner = {runAsync: vi.fn().mockReturnValue(mockRunAsync())};
    const userContent: Content = {parts: [{text: 'User query'}]};

    const events: Event[] = [];
    for await (const event of EvaluationGenerator.generateInferencesForSingleUserInvocation(
      runner as unknown as Runner,
      'test_user',
      'test_session',
      userContent,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].author).toBe('user');
    expect(events[0].content).toBe(userContent);
    expect(events[0].invocationId).toBe('inv1');
    expect(events[1].author).toBe('agent');
    expect(events[1].content?.parts).toEqual(agentParts);
    expect(runner.runAsync).toHaveBeenCalledWith({
      userId: 'test_user',
      sessionId: 'test_session',
      newMessage: userContent,
    });
  });

  it('emits the synthetic user event only once per turn', async () => {
    async function* mockRunAsync(): AsyncGenerator<Event> {
      yield buildEvent('agent', [{text: 'first'}], 'inv1');
      yield buildEvent('agent', [{text: 'second'}], 'inv1');
    }
    const runner = {runAsync: vi.fn().mockReturnValue(mockRunAsync())};

    const events: Event[] = [];
    for await (const event of EvaluationGenerator.generateInferencesForSingleUserInvocation(
      runner as unknown as Runner,
      'user',
      'session',
      {parts: [{text: 'query'}]},
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.author)).toEqual([
      'user',
      'agent',
      'agent',
    ]);
  });
});

describe('EvaluationGenerator.generateInferencesFromRootAgent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drives the agent with the user simulator until it stops', async () => {
    const rootAgent = {name: 'mock_agent'} as unknown as BaseAgent;
    let calls = 0;
    const userSimulator = {
      getNextUserMessage: vi.fn(async (): Promise<NextUserMessage> => {
        calls += 1;
        if (calls === 1) {
          return {
            status: Status.SUCCESS,
            userMessage: {parts: [{text: 'message 1'}]},
          };
        }
        return {status: Status.STOP_SIGNAL_DETECTED};
      }),
    } as unknown as UserSimulator;

    const singleTurnSpy = vi
      .spyOn(EvaluationGenerator, 'generateInferencesForSingleUserInvocation')
      .mockImplementation(
        async function* (
          _runner,
          _userId,
          _sessionId,
          userContent,
        ): AsyncGenerator<Event> {
          yield buildEvent('user', userContent.parts ?? [], 'inv1');
          yield buildEvent('agent', [{text: 'agent_response'}], 'inv1');
        },
      );

    const invocations =
      await EvaluationGenerator.generateInferencesFromRootAgent({
        rootAgent,
        userSimulator,
      });

    expect(userSimulator.getNextUserMessage).toHaveBeenCalledTimes(2);
    expect(singleTurnSpy).toHaveBeenCalledTimes(1);
    expect(singleTurnSpy.mock.calls[0][3].parts?.[0].text).toBe('message 1');
    expect(invocations).toHaveLength(1);
    expect(invocations[0].finalResponse?.parts?.[0].text).toBe(
      'agent_response',
    );
  });

  it('uses the provided session, ids, and services', async () => {
    const rootAgent = {name: 'mock_agent'} as unknown as BaseAgent;
    const userSimulator = {
      getNextUserMessage: vi.fn(
        async (): Promise<NextUserMessage> => ({
          status: Status.STOP_SIGNAL_DETECTED,
        }),
      ),
    } as unknown as UserSimulator;
    const sessionService = new InMemorySessionService();
    const createSpy = vi.spyOn(sessionService, 'createSession');

    const invocations =
      await EvaluationGenerator.generateInferencesFromRootAgent({
        rootAgent,
        userSimulator,
        initialSession: {appName: 'my_app', userId: 'my_user', state: {k: 'v'}},
        sessionId: 'sess-1',
        sessionService,
        artifactService: new InMemoryArtifactService(),
        memoryService: new InMemoryMemoryService(),
      });

    expect(invocations).toEqual([]);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'my_app',
        userId: 'my_user',
        sessionId: 'sess-1',
        state: {k: 'v'},
      }),
    );
  });
});
