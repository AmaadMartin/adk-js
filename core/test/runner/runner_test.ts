/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  createEvent,
  deleteResolvedTransaction,
  Event,
  findEventByLastFunctionResponseId,
  getLastFunctionResponseId,
  getPendingTransactions,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  recordPendingTransactions,
  Runner,
  Session,
  TRANSACTION_STATE_KEY,
} from '@google/adk';
import {Content, FunctionCall, FunctionResponse} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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

class MockToolCallAgent extends LlmAgent {
  constructor(
    name: string,
    private functionCallIds: string[],
    parentAgent?: BaseAgent,
  ) {
    super({
      name,
      model: 'gemini-2.5-flash',
      subAgents: [],
      parentAgent,
    });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const parts = this.functionCallIds.map((id) => ({
      functionCall: {
        id,
        name: 'test_tool',
        args: {},
      },
    }));
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts,
      },
    });
  }
}

describe('Runner transaction tracking and resumption optimization (b/425992518)', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let rootAgent: MockLlmAgent;
  let toolAgent1: MockToolCallAgent;
  let toolAgent2: MockToolCallAgent;
  let runner: Runner;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    rootAgent = new MockLlmAgent('root_agent');
    toolAgent1 = new MockToolCallAgent('tool_agent1', ['call_1'], rootAgent);
    toolAgent2 = new MockToolCallAgent(
      'tool_agent2',
      ['call_resumed'],
      rootAgent,
    );
    rootAgent.subAgents.push(toolAgent1, toolAgent2);

    runner = new Runner({
      appName: TEST_APP_ID,
      agent: rootAgent,
      sessionService,
      artifactService,
    });
  });

  it('should record pending transactions in session.state when agent emits function calls during runAsync', async () => {
    const runnerTool1 = new Runner({
      appName: TEST_APP_ID,
      agent: toolAgent1,
      sessionService,
      artifactService,
    });

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    for await (const _ of runnerTool1.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'run tool'}]},
    })) {
      // Consume stream
    }

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const transactions = getPendingTransactions(updatedSession!);
    expect(transactions).toBeDefined();
    expect(transactions!['call_1']).toEqual({
      eventId: expect.any(String),
      author: 'tool_agent1',
      timestamp: expect.any(Number),
    });
  });

  it('should resolve agent in O(1) time from session.state and clean up resolved transaction upon resumption', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      state: {
        [TRANSACTION_STATE_KEY]: {
          initial_call_from_agent2: {
            eventId: 'ev_123',
            author: 'tool_agent2',
            timestamp: 1000,
          },
        },
      },
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'initial_call_from_agent2',
              name: 'test_tool',
              response: {status: 'ok'},
            },
          },
        ],
      },
    })) {
      events.push(event);
    }

    expect(events[0].author).toBe('tool_agent2');

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const transactions = getPendingTransactions(updatedSession!);
    expect(transactions?.['initial_call_from_agent2']).toBeUndefined();
    expect(transactions?.['call_resumed']).toBeDefined();
  });

  it('should fall back to findEventByLastFunctionResponseId when _adk_transactions is unpopulated in session.state', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const callEvent = createEvent({
      invocationId: 'inv_1',
      author: 'tool_agent1',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'legacy_call_id',
              name: 'test_tool',
              args: {},
            },
          },
        ],
      },
    });
    await sessionService.appendEvent({session, event: callEvent});

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'legacy_call_id',
              name: 'test_tool',
              response: {status: 'ok'},
            },
          },
        ],
      },
    })) {
      events.push(event);
    }

    expect(events[0].author).toBe('tool_agent1');
  });

  it('should guard safely and fall back cleanly when session.state._adk_transactions is malformed or corrupted', async () => {
    const corruptedValues = [null, 12345, 'invalid_string', ['array']];

    for (let i = 0; i < corruptedValues.length; i++) {
      const corruptVal = corruptedValues[i];
      const session = await sessionService.createSession({
        appName: TEST_APP_ID,
        userId: TEST_USER_ID,
        sessionId: `${TEST_SESSION_ID}_corrupt_${i}`,
        state: {
          [TRANSACTION_STATE_KEY]: corruptVal as unknown as Record<
            string,
            unknown
          >,
        },
      });

      expect(getPendingTransactions(session)).toBeUndefined();

      const callEvent = createEvent({
        invocationId: `inv_corrupt_${i}`,
        author: 'tool_agent1',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: `corrupt_call_${i}`,
                name: 'test_tool',
                args: {},
              },
            },
          ],
        },
      });
      await sessionService.appendEvent({session, event: callEvent});

      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: session.userId,
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: `corrupt_call_${i}`,
                name: 'test_tool',
                response: {status: 'ok'},
              },
            },
          ],
        },
      })) {
        events.push(event);
      }

      expect(events[0].author).toBe('tool_agent1');
    }
  });

  it('should log warning and fall back to rootAgent when resolved author from transaction state is unknown', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      state: {
        [TRANSACTION_STATE_KEY]: {
          call_ghost: {
            eventId: 'ev_ghost',
            author: 'ghost_agent',
            timestamp: 1000,
          },
        },
      },
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_ghost',
              name: 'test_tool',
              response: {status: 'ok'},
            },
          },
        ],
      },
    })) {
      events.push(event);
    }

    expect(events[0].author).toBe('root_agent');
    warnSpy.mockRestore();
  });

  it('should handle zero-allocation inline scanning in findEventByLastFunctionResponseId across large event history', () => {
    const events: Event[] = [];
    const numEvents = 5000;
    const targetCallId = 'target_call_999';

    for (let i = 0; i < numEvents; i++) {
      events.push(
        createEvent({
          invocationId: `inv_${i}`,
          author: `agent_${i % 10}`,
          content: {
            role: 'model',
            parts: [
              {text: `Message ${i}`},
              {
                functionCall: {
                  id: i === 1234 ? targetCallId : `call_${i}`,
                  name: 'some_tool',
                  args: {},
                },
              },
            ],
          },
        }),
      );
    }

    events.push(
      createEvent({
        invocationId: 'inv_last',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {text: 'some text'},
            {
              functionResponse: {
                id: targetCallId,
                name: 'some_tool',
                response: {result: 'success'},
              },
            },
          ],
        },
      }),
    );

    const found = findEventByLastFunctionResponseId(events);
    expect(found).toBeDefined();
    expect(found!.id).toBe(events[1234].id);
    expect(found!.author).toBe('agent_4');

    expect(findEventByLastFunctionResponseId([])).toBeNull();
    expect(
      findEventByLastFunctionResponseId([
        createEvent({
          invocationId: 'inv_no_response',
          author: 'user',
          content: {role: 'user', parts: [{text: 'just text'}]},
        }),
      ]),
    ).toBeNull();
    expect(
      getLastFunctionResponseId([
        createEvent({
          invocationId: 'inv_no_parts',
          author: 'user',
          content: undefined as unknown as Content,
        }),
      ]),
    ).toBeUndefined();
  });

  it('should directly test standalone utilities recordPendingTransactions and deleteResolvedTransaction edge cases', () => {
    const dummySession: Session = {
      id: 's1',
      appName: 'app1',
      userId: 'u1',
      state: {},
      events: [],
      lastUpdateTime: 0,
    };

    expect(
      getPendingTransactions(undefined as unknown as Session),
    ).toBeUndefined();
    expect(getPendingTransactions(dummySession)).toBeUndefined();

    recordPendingTransactions(undefined as unknown as Session, {} as Event);
    recordPendingTransactions(dummySession, {} as Event);

    const eventWithNoParts = createEvent({
      invocationId: 'inv',
      author: 'agent1',
      content: {role: 'model', parts: []},
    });
    recordPendingTransactions(dummySession, eventWithNoParts);
    expect(getPendingTransactions(dummySession)).toBeUndefined();

    const eventWithCall = createEvent({
      invocationId: 'inv',
      author: 'agent1',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'c1', name: 't1', args: {}}},
          {functionCall: {id: 'c2', name: 't2', args: {}}},
        ],
      },
    });
    recordPendingTransactions(dummySession, eventWithCall);
    expect(getPendingTransactions(dummySession)).toEqual({
      c1: {
        eventId: eventWithCall.id,
        author: 'agent1',
        timestamp: eventWithCall.timestamp,
      },
      c2: {
        eventId: eventWithCall.id,
        author: 'agent1',
        timestamp: eventWithCall.timestamp,
      },
    });

    expect(
      deleteResolvedTransaction(dummySession, 'non_existent_call'),
    ).toBeUndefined();

    const deletedEntry = deleteResolvedTransaction(dummySession, 'c1');
    expect(deletedEntry).toEqual({
      eventId: eventWithCall.id,
      author: 'agent1',
      timestamp: eventWithCall.timestamp,
    });
    expect(getPendingTransactions(dummySession)?.['c1']).toBeUndefined();
    expect(getPendingTransactions(dummySession)?.['c2']).toBeDefined();
  });
});
