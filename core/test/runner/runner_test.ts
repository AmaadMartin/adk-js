/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  Session,
} from '@google/adk';
import {Content, FunctionCall, FunctionResponse} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  findEventByLastFunctionResponseId,
  syncSessionResumptionIndex,
} from '../../src/runner/runner.js';

const TEST_APP_ID = 'test_app_id';
const TEST_USER_ID = 'test_user_id';
const TEST_SESSION_ID = 'test_session_id';
const TEST_MESSAGE = 'test_message';

class MockLlmAgent extends LlmAgent {
  constructor(
    name: string,
    disallowTransferToParent = false,
    parentAgent?: BaseAgent,
  ) {
    super({
      name,
      model: 'gemini-2.5-flash',
      subAgents: [],
      parentAgent,
      disallowTransferToParent,
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Test LLM response'}]},
    });
  }
}

class MockPlugin extends BasePlugin {
  static ON_USER_CALLBACK_MSG =
    'Modified user message ON_USER_CALLBACK_MSG from MockPlugin';
  static ON_EVENT_CALLBACK_MSG =
    'Modified event ON_EVENT_CALLBACK_MSG from MockPlugin';
  static BEFORE_RUN_CALLBACK_MSG =
    'Before run callback message from MockPlugin';

  enableUserMessageCallback = false;
  enableEventCallback = false;
  enableBeforeRunCallback = false;
  afterRunCallbackCalled = false;

  constructor() {
    super('mock_plugin');
  }

  override async onUserMessageCallback(_params: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    if (!this.enableUserMessageCallback) {
      return undefined;
    }
    return {
      role: 'model',
      parts: [{text: MockPlugin.ON_USER_CALLBACK_MSG}],
    };
  }

  override async onEventCallback({
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    if (!this.enableEventCallback) {
      return undefined;
    }
    return createEvent({
      invocationId: '',
      author: '',
      content: {
        parts: [
          {
            text: MockPlugin.ON_EVENT_CALLBACK_MSG,
          },
        ],
        role: event.content!.role,
      },
    });
  }

  override async beforeRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    if (!this.enableBeforeRunCallback) {
      return undefined;
    }
    return {
      role: 'model',
      parts: [{text: MockPlugin.BEFORE_RUN_CALLBACK_MSG}],
    };
  }

  override async afterRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    this.afterRunCallbackCalled = true;
    return Promise.resolve();
  }
}

describe('Runner.determineAgentForResumption', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let rootAgent: MockLlmAgent;
  let subAgent1: MockLlmAgent;
  let subAgent2: MockLlmAgent;
  let nonTransferableAgent: MockLlmAgent;
  let runner: Runner;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    rootAgent = new MockLlmAgent('root_agent');
    subAgent1 = new MockLlmAgent('sub_agent1', false, rootAgent);
    subAgent2 = new MockLlmAgent('sub_agent2', false, rootAgent);
    nonTransferableAgent = new MockLlmAgent(
      'non_transferable',
      true,
      rootAgent,
    );
    rootAgent.subAgents.push(subAgent1, subAgent2, nonTransferableAgent);

    runner = new Runner({
      appName: TEST_APP_ID,
      agent: rootAgent,
      sessionService,
      artifactService,
    });
  });

  /**
   * Run a single test with a given set of events. Creates a session and appends
   * all events followed by a simple user message to synchronously run the
   * model.
   */
  async function runTest(inputEvents: Event[]) {
    // This runTest works for most scenarios but not all. It may need to be
    // refactored in the future for more flexibility.
    if (inputEvents.length === 0) {
      throw new Error('No input events provided');
    }

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    for (const event of inputEvents) {
      await sessionService.appendEvent({session: session, event: event});
    }

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
    })) {
      events.push(event);
    }

    return events;
  }

  it('should find agent when last event is function response', async () => {
    const functionCall: FunctionCall = {
      id: 'func_123',
      name: 'test_func',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_123',
      name: 'test_func',
      response: {},
    };

    const callEvent = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{functionCall}]},
    });

    const responseEvent = createEvent({
      invocationId: 'inv2',
      author: 'user',
      content: {role: 'user', parts: [{functionResponse}]},
    });

    const events = await runTest([callEvent, responseEvent]);

    expect(events[0].author).toBe('sub_agent1');
  });

  it('should return root agent when session has no non-user events', async () => {
    const nonUserEvent = createEvent({
      invocationId: 'inv1',
      author: 'user',
      content: {role: 'user', parts: [{text: 'Hello'}]},
    });

    const events = await runTest([nonUserEvent]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should return root agent when it is found in session events', async () => {
    const rootEvent = createEvent({
      invocationId: 'inv1',
      author: 'root_agent',
      content: {role: 'model', parts: [{text: 'Root response'}]},
    });

    const events = await runTest([rootEvent]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should return transferable sub agent when found', async () => {
    const subAgent1Event = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'Sub agent response'}]},
    });

    const events = await runTest([subAgent1Event]);

    expect(events[0].author).toBe('sub_agent1');
  });

  it('should skip non-transferable agent and return root agent', async () => {
    const nonTransferableResponse = createEvent({
      invocationId: 'inv1',
      author: 'non_transferable',
      content: {
        role: 'model',
        parts: [{text: 'Non-transferable response'}],
      },
    });

    const events = await runTest([nonTransferableResponse]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should skip unknown agent and return root agent', async () => {
    const unknownEvent = createEvent({
      invocationId: 'inv1',
      author: 'unknown_agent',
      content: {
        role: 'model',
        parts: [{text: 'Unknown agent response'}],
      },
    });

    const rootAgentEvent = createEvent({
      invocationId: 'inv2',
      author: 'root_agent',
      content: {role: 'model', parts: [{text: 'Root response'}]},
    });

    const events = await runTest([unknownEvent, rootAgentEvent]);

    expect(events[0].author).toBe('root_agent');
  });

  it('should prioritize function response scenario', async () => {
    const functionCall: FunctionCall = {
      id: 'func_456',
      name: 'test_func',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_456',
      name: 'test_func',
      response: {},
    };

    const callEvent = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent2',
      content: {role: 'model', parts: [{functionCall}]},
    });

    const rootEvent = createEvent({
      invocationId: 'inv2',
      author: 'root_agent',
      content: {role: 'model', parts: [{text: 'Root response'}]},
    });

    // Bypass the runTest method for finer control over events.
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    await sessionService.appendEvent({session: session, event: callEvent});
    await sessionService.appendEvent({session: session, event: rootEvent});

    const events: Event[] = [];

    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{functionResponse}]},
    })) {
      events.push(event);
    }

    expect(events[0].author).toBe('sub_agent2');
  });

  it('should incrementally update index when determineAgentForResumption is called multiple times as new events are appended', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const event1 = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'First response'}]},
    });
    const event2 = createEvent({
      invocationId: 'inv2',
      author: 'user',
      content: {role: 'user', parts: [{text: 'User follow up'}]},
    });

    session.events.push(event1, event2);

    const runnerPrivate = runner as unknown as {
      determineAgentForResumption(
        session: Session,
        rootAgent: BaseAgent,
      ): BaseAgent;
    };
    const firstResolved = runnerPrivate.determineAgentForResumption(
      session,
      rootAgent,
    );
    expect(firstResolved.name).toBe('sub_agent1');

    const indexAfterFirst = syncSessionResumptionIndex(session);
    expect(indexAfterFirst.lastIndexedLength).toBe(2);
    expect(indexAfterFirst.agentEventIndices).toEqual([0]);

    const event3 = createEvent({
      invocationId: 'inv3',
      author: 'sub_agent2',
      content: {role: 'model', parts: [{text: 'Second response'}]},
    });
    const event4 = createEvent({
      invocationId: 'inv4',
      author: 'user',
      content: {role: 'user', parts: [{text: 'Another user follow up'}]},
    });

    session.events.push(event3, event4);

    const secondResolved = runnerPrivate.determineAgentForResumption(
      session,
      rootAgent,
    );
    expect(secondResolved.name).toBe('sub_agent2');

    const indexAfterSecond = syncSessionResumptionIndex(session);
    expect(indexAfterSecond).toBe(indexAfterFirst);
    expect(indexAfterSecond.lastIndexedLength).toBe(4);
    expect(indexAfterSecond.agentEventIndices).toEqual([0, 2]);
  });

  it('should cleanly reset index when session events array is truncated or replaced', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const event1 = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'First response'}]},
    });
    const event2 = createEvent({
      invocationId: 'inv2',
      author: 'user',
      content: {role: 'user', parts: [{text: 'User message'}]},
    });
    const event3 = createEvent({
      invocationId: 'inv3',
      author: 'sub_agent2',
      content: {role: 'model', parts: [{text: 'Second response'}]},
    });

    session.events.push(event1, event2, event3);

    const runnerPrivate = runner as unknown as {
      determineAgentForResumption(
        session: Session,
        rootAgent: BaseAgent,
      ): BaseAgent;
    };
    const firstResolved = runnerPrivate.determineAgentForResumption(
      session,
      rootAgent,
    );
    expect(firstResolved.name).toBe('sub_agent2');

    // Truncate events array in place
    session.events.length = 1;
    const truncatedResolved = runnerPrivate.determineAgentForResumption(
      session,
      rootAgent,
    );
    expect(truncatedResolved.name).toBe('sub_agent1');
    const indexAfterTruncation = syncSessionResumptionIndex(session);
    expect(indexAfterTruncation.lastIndexedLength).toBe(1);
    expect(indexAfterTruncation.agentEventIndices).toEqual([0]);

    // Replace events array completely
    session.events = [
      createEvent({
        invocationId: 'inv4',
        author: 'root_agent',
        content: {role: 'model', parts: [{text: 'Root replaced'}]},
      }),
    ];
    const replacedResolved = runnerPrivate.determineAgentForResumption(
      session,
      rootAgent,
    );
    expect(replacedResolved.name).toBe('root_agent');
    const indexAfterReplacement = syncSessionResumptionIndex(session);
    expect(indexAfterReplacement.lastIndexedLength).toBe(1);
    expect(indexAfterReplacement.agentEventIndices).toEqual([0]);
  });

  it('should perform efficiently and handle long-running sessions with 5,000+ events without memory leaks or stack overflows', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const events: Event[] = [];
    for (let i = 0; i < 5000; i++) {
      if (i === 4998) {
        events.push(
          createEvent({
            invocationId: `inv_${i}`,
            author: 'sub_agent1',
            content: {role: 'model', parts: [{text: `Event ${i}`}]},
          }),
        );
      } else {
        events.push(
          createEvent({
            invocationId: `inv_${i}`,
            author: 'user',
            content: {role: 'user', parts: [{text: `User event ${i}`}]},
          }),
        );
      }
    }
    session.events = events;

    const runnerPrivate = runner as unknown as {
      determineAgentForResumption(
        session: Session,
        rootAgent: BaseAgent,
      ): BaseAgent;
    };

    const start = performance.now();
    const resolvedAgent = runnerPrivate.determineAgentForResumption(
      session,
      rootAgent,
    );
    const duration = performance.now() - start;

    expect(resolvedAgent.name).toBe('sub_agent1');
    expect(duration).toBeLessThan(500);

    const startSecond = performance.now();
    const secondResolved = runnerPrivate.determineAgentForResumption(
      session,
      rootAgent,
    );
    const durationSecond = performance.now() - startSecond;

    expect(secondResolved.name).toBe('sub_agent1');
    expect(durationSecond).toBeLessThan(20);
  });

  it('should find matching function call in O(1) using functionCallEventMap when session is provided to findEventByLastFunctionResponseId', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const functionCall: FunctionCall = {
      id: 'func_999',
      name: 'long_running_op',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_999',
      name: 'long_running_op',
      response: {status: 'ok'},
    };

    const callEvent = createEvent({
      invocationId: 'inv_0',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{functionCall}]},
    });
    session.events.push(callEvent);

    for (let i = 1; i <= 100; i++) {
      session.events.push(
        createEvent({
          invocationId: `inv_${i}`,
          author: 'user',
          content: {role: 'user', parts: [{text: `intervening ${i}`}]},
        }),
      );
    }

    const responseEvent = createEvent({
      invocationId: 'inv_101',
      author: 'user',
      content: {role: 'user', parts: [{functionResponse}]},
    });
    session.events.push(responseEvent);

    const foundEvent = findEventByLastFunctionResponseId(
      session.events,
      session,
    );
    expect(foundEvent).toBe(callEvent);

    const index = syncSessionResumptionIndex(session);
    expect(index.functionCallEventMap.get('func_999')?.author).toBe(
      'sub_agent1',
    );
  });
});

describe('Runner resumption indexing edge cases and 100% coverage', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let rootAgent: LlmAgent;
  let runner: Runner;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    rootAgent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
    });
    runner = new Runner({
      appName: TEST_APP_ID,
      agent: rootAgent,
      sessionService,
      artifactService,
    });
  });

  it('should handle findEventByLastFunctionResponseId with empty events array and invalid functionResponse structures', () => {
    expect(findEventByLastFunctionResponseId([])).toBeNull();

    const noContentEvent = createEvent({
      author: 'user',
    });
    expect(findEventByLastFunctionResponseId([noContentEvent])).toBeNull();

    const noResponsePartEvent = createEvent({
      author: 'user',
      content: {role: 'user', parts: [{text: 'Just text'}]},
    });
    expect(findEventByLastFunctionResponseId([noResponsePartEvent])).toBeNull();

    const noIdResponseEvent = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {name: 'test', response: {}},
          } as unknown as Content['parts'][0],
        ],
      },
    });
    expect(findEventByLastFunctionResponseId([noIdResponseEvent])).toBeNull();
  });

  it('should handle findEventByLastFunctionResponseId with and without session fallback and branch conditions', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const callEvent = createEvent({
      invocationId: 'inv_call',
      author: 'root_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc_1', name: 'op', args: {}}}],
      },
    });
    const otherCallEvent = createEvent({
      invocationId: 'inv_other',
      author: 'root_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc_2', name: 'op2', args: {}}}],
      },
    });
    const noFuncCallEvent = createEvent({
      invocationId: 'inv_text',
      author: 'root_agent',
      content: {role: 'model', parts: [{text: 'normal text'}]},
    });
    const responseEvent = createEvent({
      invocationId: 'inv_resp',
      author: 'user',
      content: {
        role: 'user',
        parts: [{functionResponse: {id: 'fc_1', name: 'op', response: {}}}],
      },
    });

    session.events.push(
      callEvent,
      otherCallEvent,
      noFuncCallEvent,
      responseEvent,
    );

    // With session: match found in index
    expect(findEventByLastFunctionResponseId(session.events, session)).toBe(
      callEvent,
    );

    // With session: functionResponse id not in map
    const unknownRespEvent = createEvent({
      invocationId: 'inv_unknown',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {id: 'fc_missing', name: 'op', response: {}}},
        ],
      },
    });
    session.events.push(unknownRespEvent);
    expect(
      findEventByLastFunctionResponseId(session.events, session),
    ).toBeNull();

    // With session: event mapped to lastEvent itself
    const selfRespEvent = createEvent({
      invocationId: 'inv_self',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {functionCall: {id: 'fc_self', name: 'self_op', args: {}}},
          {functionResponse: {id: 'fc_self', name: 'self_op', response: {}}},
        ],
      },
    });
    session.events.push(selfRespEvent);
    expect(
      findEventByLastFunctionResponseId(session.events, session),
    ).toBeNull();

    // Without session (fallback O(N) scan):
    const eventsWithoutSession = [
      callEvent,
      otherCallEvent,
      noFuncCallEvent,
      responseEvent,
    ];
    expect(findEventByLastFunctionResponseId(eventsWithoutSession)).toBe(
      callEvent,
    );

    // Fallback O(N) scan when id not found anywhere:
    const eventsNoMatch = [otherCallEvent, noFuncCallEvent, unknownRespEvent];
    expect(findEventByLastFunctionResponseId(eventsNoMatch)).toBeNull();

    // Fallback triggered when session is passed but session.events !== events array instance
    const clonedEvents = [...session.events];
    expect(findEventByLastFunctionResponseId(clonedEvents, session)).toBeNull(); // selfRespEvent at end with fc_self only on selfRespEvent
  });

  it('should cover determineAgentForResumption branch conditions for function response author edge cases', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    // Case where findEventByLastFunctionResponseId finds an event with no author
    const callNoAuthor = createEvent({
      invocationId: 'inv_no_author',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc_no_auth', name: 'op', args: {}}}],
      },
    });
    delete (callNoAuthor as {author?: string}).author;

    const respEvent = createEvent({
      invocationId: 'inv_resp',
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {id: 'fc_no_auth', name: 'op', response: {}}},
        ],
      },
    });
    session.events.push(callNoAuthor, respEvent);

    const runnerPrivate = runner as unknown as {
      determineAgentForResumption(
        session: Session,
        rootAgent: BaseAgent,
      ): BaseAgent;
    };
    expect(runnerPrivate.determineAgentForResumption(session, rootAgent)).toBe(
      rootAgent,
    );

    // Case where findEventByLastFunctionResponseId finds an event with an author not in rootAgent
    const callUnknownAuthor = createEvent({
      invocationId: 'inv_unknown_auth',
      author: 'external_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc_ext', name: 'op', args: {}}}],
      },
    });
    const respExtEvent = createEvent({
      invocationId: 'inv_resp_ext',
      author: 'user',
      content: {
        role: 'user',
        parts: [{functionResponse: {id: 'fc_ext', name: 'op', response: {}}}],
      },
    });
    session.events.push(callUnknownAuthor, respExtEvent);
    expect(runnerPrivate.determineAgentForResumption(session, rootAgent)).toBe(
      rootAgent,
    );
  });
});

describe('Runner with plugins', () => {
  let plugin: MockPlugin;
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let runner: Runner;

  beforeEach(() => {
    plugin = new MockPlugin();
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    runner = new Runner({
      appName: TEST_APP_ID,
      agent: new MockLlmAgent('test_agent'),
      sessionService,
      artifactService,
      plugins: [plugin],
    });
  });

  async function runTest(originalUserInput = 'Hello'): Promise<Event[]> {
    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: {role: 'user', parts: [{text: originalUserInput}]},
    })) {
      events.push(event);
    }
    return events;
  }

  it('should initialize with plugins', async () => {
    await runTest();
    expect(runner.pluginManager).toBeDefined();
  });

  it('should modify user message before execution', async () => {
    const originalUserInput = 'original_input';
    plugin.enableUserMessageCallback = true;

    await runTest(originalUserInput);
    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const generatedEvent = session!.events[0];
    const modifiedUserMessage = generatedEvent.content!.parts![0].text;

    expect(modifiedUserMessage).toEqual(MockPlugin.ON_USER_CALLBACK_MSG);
  });

  it('should modify event after execution', async () => {
    plugin.enableEventCallback = true;

    const events = await runTest();
    const generatedEvent = events[0];
    const modifiedEventMessage = generatedEvent.content!.parts![0].text;

    expect(modifiedEventMessage).toEqual(MockPlugin.ON_EVENT_CALLBACK_MSG);
  });

  it('should call beforeRunCallback and stop execution', async () => {
    plugin.enableBeforeRunCallback = true;

    const events = await runTest();
    expect(events.length).toBe(1);
    const event = events[0];
    expect(event.content?.parts?.[0].text).toEqual(
      MockPlugin.BEFORE_RUN_CALLBACK_MSG,
    );
    expect(event.author).toEqual('model');
  });

  it('should call afterRunCallback', async () => {
    await runTest();
    expect(plugin.afterRunCallbackCalled).toBe(true);
  });

  it('should respect abort signal after onUserMessageCallback', async () => {
    const abortController = new AbortController();
    plugin.enableUserMessageCallback = true;

    const originalCallback = plugin.onUserMessageCallback;
    plugin.onUserMessageCallback = async (params) => {
      await originalCallback.call(plugin, params);
      abortController.abort();
      return undefined;
    };

    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      abortSignal: abortController.signal,
    })) {
      events.push(event);
    }

    expect(events.length).toBe(0);

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    expect(session!.events.length).toBe(0);
  });

  it('should respect abort signal after beforeRunCallback', async () => {
    const abortController = new AbortController();
    plugin.enableBeforeRunCallback = true;

    const originalCallback = plugin.beforeRunCallback;
    plugin.beforeRunCallback = async (params) => {
      await originalCallback.call(plugin, params);
      abortController.abort();
      return undefined;
    };

    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      abortSignal: abortController.signal,
    })) {
      events.push(event);
    }

    expect(events.length).toBe(0);

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    expect(session!.events.length).toBe(1);
    expect(session!.events[0].author).toBe('user');
  });

  it('should respect abort signal after onEventCallback', async () => {
    const abortController = new AbortController();
    plugin.enableEventCallback = true;

    const originalCallback = plugin.onEventCallback;
    plugin.onEventCallback = async (params) => {
      await originalCallback.call(plugin, params);
      abortController.abort();
      return undefined;
    };

    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      abortSignal: abortController.signal,
    })) {
      events.push(event);
    }

    expect(events.length).toBe(0);

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    expect(session!.events.length).toBe(2);
    expect(session!.events[1].author).toBe('test_agent');
  });
});

describe('Runner error handling', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
  });

  async function runTestExpectingError(
    runner: Runner,
    sessionId: string,
    userId: string,
  ): Promise<Error | null> {
    try {
      for await (const event of runner.runAsync({
        userId,
        sessionId,
        newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
      })) {
        console.log('Unexpected event:', event);
      }
      return null;
    } catch (e) {
      return e as Error;
    }
  }

  it('should throw clear error when appName is not configured in runner', async () => {
    const agent = new MockLlmAgent('test_agent');
    // @ts-expect-error - Intentionally omitting appName to test error handling
    const runner = new Runner({
      agent: agent,
      sessionService,
      artifactService,
    });

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const error = await runTestExpectingError(
      runner,
      session.id,
      session.userId,
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain(
      'appName must be provided in runner constructor',
    );
  });

  it('should throw session not found error when session does not exist', async () => {
    const agent = new MockLlmAgent('test_agent');

    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: agent,
      sessionService,
      artifactService,
    });

    const nonExistentSessionId = 'non_existent_session_id';

    const error = await runTestExpectingError(
      runner,
      nonExistentSessionId,
      TEST_USER_ID,
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain(
      `Session not found: ${nonExistentSessionId}`,
    );
  });
});

describe('Runner customMetadata support', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let agent: MockLlmAgent;
  let runner: Runner;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    agent = new MockLlmAgent('test_agent');
    runner = new Runner({
      appName: TEST_APP_ID,
      agent: agent,
      sessionService,
      artifactService,
    });
  });

  it('should propagate customMetadata in runAsync and attach to user event', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const customMetadata = {testKey: 'testValue', anotherKey: 123};

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      customMetadata,
    })) {
      events.push(event);
    }

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    expect(updatedSession).not.toBeNull();
    expect(updatedSession!.events).toHaveLength(2);

    const userEvent = updatedSession!.events[0];
    expect(userEvent.author).toBe('user');
    expect(userEvent.customMetadata).toEqual(customMetadata);
  });

  it('should propagate customMetadata in runEphemeral and attach to user event', async () => {
    const customMetadata = {testKey: 'testValue', anotherKey: 123};
    const appendEventSpy = vi.spyOn(sessionService, 'appendEvent');

    const events: Event[] = [];
    for await (const event of runner.runEphemeral({
      userId: TEST_USER_ID,
      newMessage: {role: 'user', parts: [{text: 'Hello'}]},
      customMetadata,
    })) {
      events.push(event);
    }

    const userEventCall = appendEventSpy.mock.calls.find(
      (call) => call[0].event.author === 'user',
    );

    expect(userEventCall).toBeDefined();
    expect(userEventCall![0].event.customMetadata).toEqual(customMetadata);

    appendEventSpy.mockRestore();
  });
});
