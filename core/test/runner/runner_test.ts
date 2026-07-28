/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  applyLiveMultiAgentTranscriptionDefaults,
  BaseAgent,
  BasePlugin,
  BaseTool,
  BaseToolset,
  createEvent,
  createResumabilityConfig,
  determineAgentForResumption,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  isRoutableLlmAgent,
  LiveRequestQueue,
  LlmAgent,
  RunConfig,
  Runner,
  shouldAppendEvent,
  StreamingMode,
} from '@google/adk';
import {
  AudioTranscriptionConfig,
  Content,
  FunctionCall,
  FunctionResponse,
  Modality,
} from '@google/genai';
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

/**
 * A mock live agent that overrides `runLiveImpl` directly (bypassing the
 * unimplemented `runLiveFlow`). It captures the received `InvocationContext` and
 * yields either a configurable list of events or a custom generator, so tests
 * can exercise `Runner.runLive` without a real model or live connection.
 */
class MockLiveAgent extends LlmAgent {
  capturedContext?: InvocationContext;
  liveEvents: Event[] = [];
  liveImpl?: (context: InvocationContext) => AsyncGenerator<Event, void, void>;

  constructor(name: string, parentAgent?: BaseAgent) {
    super({name, model: 'gemini-2.5-flash', subAgents: [], parentAgent});
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.capturedContext = context;
    if (this.liveImpl) {
      yield* this.liveImpl(context);
      return;
    }
    for (const event of this.liveEvents) {
      yield event;
    }
  }
}

/**
 * A minimal toolset whose `close` can be spied on to assert cleanup.
 */
class MockLiveToolset extends BaseToolset {
  constructor() {
    super([]);
  }

  override async getTools(): Promise<BaseTool[]> {
    return [];
  }

  override async close(): Promise<void> {
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
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
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

  it('should inherit resumabilityConfig from app when constructed with an App', async () => {
    const app = new App({
      name: TEST_APP_ID,
      rootAgent,
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
    });
    const appRunner = new Runner({
      app,
      sessionService,
      artifactService,
    });

    expect(appRunner.resumabilityConfig?.isResumable).toBe(true);
  });

  it('should skip function response resumption routing when resumabilityConfig.isResumable is false or undefined', async () => {
    const nonResumableRunner = new Runner({
      appName: TEST_APP_ID,
      agent: rootAgent,
      sessionService,
      artifactService,
      resumabilityConfig: createResumabilityConfig({isResumable: false}),
    });

    const functionCall: FunctionCall = {
      id: 'func_789',
      name: 'test_func',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_789',
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

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: 'session_non_resumable',
    });

    await sessionService.appendEvent({session, event: callEvent});
    await sessionService.appendEvent({session, event: rootEvent});

    const events: Event[] = [];
    for await (const event of nonResumableRunner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{functionResponse}]},
    })) {
      events.push(event);
    }

    expect(events[0].author).toBe('root_agent');
  });

  it('should route to sub-agent when resuming from an LRO function response across session boundaries', async () => {
    const lroCall: FunctionCall = {
      id: 'lro_vertex_ai_123',
      name: 'vertex_ai_pipeline_run',
      args: {model: 'gemini-pro'},
    };
    const lroResponse: FunctionResponse = {
      id: 'lro_vertex_ai_123',
      name: 'vertex_ai_pipeline_run',
      response: {status: 'COMPLETED'},
    };

    const callEvent = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{functionCall: lroCall}]},
    });

    const responseEvent = createEvent({
      invocationId: 'inv2',
      author: 'user',
      content: {role: 'user', parts: [{functionResponse: lroResponse}]},
    });

    const events = await runTest([callEvent, responseEvent]);
    expect(events[0].author).toBe('sub_agent1');
  });

  it('should fall through to Case 2 when matching function response author is no longer in rootAgent hierarchy', async () => {
    const functionCall: FunctionCall = {
      id: 'func_stale_111',
      name: 'stale_tool',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_stale_111',
      name: 'stale_tool',
      response: {data: 'ok'},
    };

    const callEvent = createEvent({
      invocationId: 'inv1',
      author: 'removed_sub_agent',
      content: {role: 'model', parts: [{functionCall}]},
    });

    const subAgent1Event = createEvent({
      invocationId: 'inv2',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'SubAgent 1 message'}]},
    });

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: 'session_stale',
    });

    await sessionService.appendEvent({session, event: callEvent});
    await sessionService.appendEvent({session, event: subAgent1Event});

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{functionResponse}]},
    })) {
      events.push(event);
    }

    expect(events[0].author).toBe('sub_agent1');
  });

  it('should verify standalone determineAgentForResumption and isRoutableLlmAgent behavior directly', async () => {
    expect(isRoutableLlmAgent(subAgent1)).toBe(true);
    expect(isRoutableLlmAgent(nonTransferableAgent)).toBe(false);

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: 'session_standalone',
    });
    const subAgent1Event = createEvent({
      invocationId: 'inv1',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'Hello'}]},
    });
    await sessionService.appendEvent({session, event: subAgent1Event});

    const result = determineAgentForResumption(
      session,
      rootAgent,
      createResumabilityConfig({isResumable: true}),
    );
    expect(result.name).toBe('sub_agent1');
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

  it('should default newMessage role to "user" when role is omitted (issue #475)', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: 'test_session_475',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {parts: [{text: 'Hello without role'}]},
    })) {
      events.push(event);
    }

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: 'test_session_475',
    });

    expect(updatedSession).not.toBeNull();
    expect(updatedSession!.events.length).toBeGreaterThan(0);

    const userEvent = updatedSession!.events[0];
    expect(userEvent.author).toBe('user');
    expect(userEvent.content?.role).toBe('user');
  });
});

describe('Runner.runLive', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let agent: MockLiveAgent;
  let runner: Runner;
  let liveRequestQueue: LiveRequestQueue;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    agent = new MockLiveAgent('live_agent');
    runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
    });
    liveRequestQueue = new LiveRequestQueue();
  });

  function createSession(sessionId = TEST_SESSION_ID) {
    return sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId,
    });
  }

  function getStoredSession(sessionId = TEST_SESSION_ID) {
    return sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId,
    });
  }

  function liveEvent(text: string, partial?: boolean): Event {
    return createEvent({
      invocationId: 'live_inv',
      author: 'live_agent',
      content: {role: 'model', parts: [{text}]},
      partial,
    });
  }

  async function collect(
    generator: AsyncGenerator<Event, void, undefined>,
  ): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of generator) {
      events.push(event);
    }
    return events;
  }

  it('yields the events produced by the agent live loop', async () => {
    await createSession();
    agent.liveEvents = [liveEvent('live-1'), liveEvent('live-2')];

    const events = await collect(
      runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
      }),
    );

    expect(events.map((e) => e.content?.parts?.[0].text)).toEqual([
      'live-1',
      'live-2',
    ]);
  });

  it('persists non-partial live events to the session', async () => {
    await createSession();
    agent.liveEvents = [liveEvent('live-1'), liveEvent('live-2')];

    await collect(
      runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
      }),
    );

    const session = await getStoredSession();
    expect(session!.events.map((e) => e.content?.parts?.[0].text)).toEqual([
      'live-1',
      'live-2',
    ]);
    expect(session!.events.every((e) => e.author === 'live_agent')).toBe(true);
  });

  it('yields but does not persist partial events', async () => {
    await createSession();
    agent.liveEvents = [liveEvent('partial', true), liveEvent('final')];

    const events = await collect(
      runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
      }),
    );

    expect(events).toHaveLength(2);
    const session = await getStoredSession();
    expect(session!.events).toHaveLength(1);
    expect(session!.events[0].content?.parts?.[0].text).toBe('final');
  });

  it('builds a BIDI context with the live queue and default AUDIO modality', async () => {
    await createSession();
    agent.liveEvents = [liveEvent('live-1')];

    await collect(
      runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
      }),
    );

    expect(agent.capturedContext?.liveRequestQueue).toBe(liveRequestQueue);
    expect(agent.capturedContext?.runConfig?.streamingMode).toBe(
      StreamingMode.BIDI,
    );
    expect(agent.capturedContext?.runConfig?.responseModalities).toEqual([
      Modality.AUDIO,
    ]);
  });

  it('preserves caller-provided responseModalities', async () => {
    await createSession();
    agent.liveEvents = [liveEvent('live-1')];

    await collect(
      runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
        runConfig: {responseModalities: [Modality.TEXT]},
      }),
    );

    expect(agent.capturedContext?.runConfig?.responseModalities).toEqual([
      Modality.TEXT,
    ]);
    expect(agent.capturedContext?.runConfig?.streamingMode).toBe(
      StreamingMode.BIDI,
    );
  });

  it('throws when the session does not exist', async () => {
    await expect(
      collect(
        runner.runLive({
          userId: TEST_USER_ID,
          sessionId: 'missing_session',
          liveRequestQueue,
        }),
      ),
    ).rejects.toThrow('Session not found: missing_session');
  });

  it('throws a clear error when appName is not configured', async () => {
    const noAppRunner = new Runner({
      agent: new MockLiveAgent('live_agent'),
      sessionService,
      artifactService,
    });
    await createSession();

    await expect(
      collect(
        noAppRunner.runLive({
          userId: TEST_USER_ID,
          sessionId: TEST_SESSION_ID,
          liveRequestQueue,
        }),
      ),
    ).rejects.toThrow('appName must be provided in runner constructor');
  });

  it('throws when liveRequestQueue is missing', async () => {
    await createSession();
    const params = {
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    } as unknown as {
      userId: string;
      sessionId: string;
      liveRequestQueue: LiveRequestQueue;
    };

    await expect(collect(runner.runLive(params))).rejects.toThrow(
      'liveRequestQueue is required for runLive.',
    );
  });

  it('resolves the agent to run via determineAgentForResumption', async () => {
    const root = new MockLiveAgent('root_agent');
    const sub = new MockLiveAgent('sub_agent1', root);
    root.subAgents.push(sub);
    sub.liveEvents = [
      createEvent({
        invocationId: 'live_inv',
        author: 'sub_agent1',
        content: {role: 'model', parts: [{text: 'sub-response'}]},
      }),
    ];

    const resolutionRunner = new Runner({
      appName: TEST_APP_ID,
      agent: root,
      sessionService,
      artifactService,
    });
    const session = await createSession('session_resolution');
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'prev',
        author: 'sub_agent1',
        content: {role: 'model', parts: [{text: 'earlier'}]},
      }),
    });

    await collect(
      resolutionRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: 'session_resolution',
        liveRequestQueue,
      }),
    );

    expect(sub.capturedContext?.agent.name).toBe('sub_agent1');
    expect(root.capturedContext).toBeUndefined();
  });

  it('applies the onEvent plugin callback while persisting the original event', async () => {
    const plugin = new MockPlugin();
    plugin.enableEventCallback = true;
    const pluginRunner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [plugin],
    });
    await createSession();
    agent.liveEvents = [liveEvent('original')];

    const events = await collect(
      pluginRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
      }),
    );

    expect(events[0].content?.parts?.[0].text).toBe(
      MockPlugin.ON_EVENT_CALLBACK_MSG,
    );
    const session = await getStoredSession();
    expect(session!.events).toHaveLength(1);
    expect(session!.events[0].content?.parts?.[0].text).toBe('original');
  });

  it('early-exits when a beforeRun plugin returns content', async () => {
    const plugin = new MockPlugin();
    plugin.enableBeforeRunCallback = true;
    const pluginRunner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [plugin],
    });
    await createSession();
    agent.liveEvents = [liveEvent('should-not-run')];

    const events = await collect(
      pluginRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('model');
    expect(events[0].content?.parts?.[0].text).toBe(
      MockPlugin.BEFORE_RUN_CALLBACK_MSG,
    );
    expect(agent.capturedContext).toBeUndefined();
    expect(plugin.afterRunCallbackCalled).toBe(false);

    const session = await getStoredSession();
    expect(session!.events).toHaveLength(1);
    expect(session!.events[0].content?.parts?.[0].text).toBe(
      MockPlugin.BEFORE_RUN_CALLBACK_MSG,
    );
  });

  it('returns immediately when the abort signal is already aborted', async () => {
    await createSession();
    agent.liveEvents = [liveEvent('live-1')];
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
        abortSignal: controller.signal,
      }),
    );

    expect(events).toHaveLength(0);
    expect(agent.capturedContext).toBeUndefined();
    const session = await getStoredSession();
    expect(session!.events).toHaveLength(0);
  });

  it('stops after the beforeRun callback when aborted', async () => {
    const controller = new AbortController();
    const plugin = new MockPlugin();
    plugin.beforeRunCallback = async () => {
      controller.abort();
      return undefined;
    };
    const pluginRunner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [plugin],
    });
    await createSession();
    agent.liveEvents = [liveEvent('live-1')];

    const events = await collect(
      pluginRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
        abortSignal: controller.signal,
      }),
    );

    expect(events).toHaveLength(0);
    expect(agent.capturedContext).toBeUndefined();
  });

  it('stops after persisting the early-exit event when aborted', async () => {
    const controller = new AbortController();
    const plugin = new MockPlugin();
    plugin.enableBeforeRunCallback = true;
    const pluginRunner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [plugin],
    });
    await createSession();
    const originalAppend = sessionService.appendEvent.bind(sessionService);
    vi.spyOn(sessionService, 'appendEvent').mockImplementation(async (args) => {
      const result = await originalAppend(args);
      controller.abort();
      return result;
    });

    const events = await collect(
      pluginRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
        abortSignal: controller.signal,
      }),
    );

    expect(events).toHaveLength(0);
    const session = await getStoredSession();
    expect(session!.events).toHaveLength(1);
    expect(session!.events[0].content?.parts?.[0].text).toBe(
      MockPlugin.BEFORE_RUN_CALLBACK_MSG,
    );
  });

  it('stops at the top of the live loop when aborted before an event is processed', async () => {
    const controller = new AbortController();
    await createSession();
    agent.liveImpl = async function* () {
      controller.abort();
      yield liveEvent('after-abort');
    };

    const events = await collect(
      runner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
        abortSignal: controller.signal,
      }),
    );

    expect(events).toHaveLength(0);
    const session = await getStoredSession();
    expect(session!.events).toHaveLength(0);
  });

  it('stops after the onEvent callback when aborted', async () => {
    const controller = new AbortController();
    const plugin = new MockPlugin();
    plugin.enableEventCallback = true;
    const originalOnEvent = plugin.onEventCallback.bind(plugin);
    plugin.onEventCallback = async (params) => {
      const result = await originalOnEvent(params);
      controller.abort();
      return result;
    };
    const pluginRunner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [plugin],
    });
    await createSession();
    agent.liveEvents = [liveEvent('live-1'), liveEvent('live-2')];

    const events = await collect(
      pluginRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
        abortSignal: controller.signal,
      }),
    );

    expect(events).toHaveLength(0);
    const session = await getStoredSession();
    expect(session!.events).toHaveLength(1);
    expect(session!.events[0].content?.parts?.[0].text).toBe('live-1');
  });

  it('completes the run even when aborted during the afterRun callback', async () => {
    const controller = new AbortController();
    const plugin = new MockPlugin();
    const originalAfterRun = plugin.afterRunCallback.bind(plugin);
    plugin.afterRunCallback = async (params) => {
      await originalAfterRun(params);
      controller.abort();
    };
    const pluginRunner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService,
      plugins: [plugin],
    });
    await createSession();
    agent.liveEvents = [liveEvent('live-1')];

    const events = await collect(
      pluginRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
        abortSignal: controller.signal,
      }),
    );

    expect(events).toHaveLength(1);
    expect(plugin.afterRunCallbackCalled).toBe(true);
  });

  it('closes toolsets after the live run completes', async () => {
    const toolset = new MockLiveToolset();
    const closeSpy = vi.spyOn(toolset, 'close');
    const toolAgent = new MockLiveAgent('tool_agent');
    toolAgent.tools.push(toolset);
    toolAgent.liveEvents = [
      createEvent({
        invocationId: 'live_inv',
        author: 'tool_agent',
        content: {role: 'model', parts: [{text: 'live-1'}]},
      }),
    ];
    const toolRunner = new Runner({
      appName: TEST_APP_ID,
      agent: toolAgent,
      sessionService,
      artifactService,
    });
    await createSession();

    await collect(
      toolRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
      }),
    );

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('runs without an artifact service configured', async () => {
    const noArtifactRunner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
    });
    await createSession();
    agent.liveEvents = [liveEvent('live-1')];

    const events = await collect(
      noArtifactRunner.runLive({
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        liveRequestQueue,
      }),
    );

    expect(events).toHaveLength(1);
    expect(agent.capturedContext?.artifactService).toBeUndefined();
  });
});

describe('shouldAppendEvent', () => {
  function transcriptionEvent(
    kind: 'input' | 'output',
    finished: boolean,
  ): Event {
    const transcription = {text: 'transcribed', finished};
    return createEvent({
      invocationId: 'inv',
      author: 'live_agent',
      ...(kind === 'input'
        ? {inputTranscription: transcription}
        : {outputTranscription: transcription}),
    });
  }

  function inlineMediaEvent(mimeType: string): Event {
    return createEvent({
      invocationId: 'inv',
      author: 'live_agent',
      content: {role: 'model', parts: [{inlineData: {mimeType, data: 'AAAA'}}]},
    });
  }

  it('appends a finished input transcription in a live call', () => {
    expect(shouldAppendEvent(transcriptionEvent('input', true), true)).toBe(
      true,
    );
  });

  it('appends an unfinished input transcription in a live call', () => {
    expect(shouldAppendEvent(transcriptionEvent('input', false), true)).toBe(
      true,
    );
  });

  it('appends a finished output transcription in a live call', () => {
    expect(shouldAppendEvent(transcriptionEvent('output', true), true)).toBe(
      true,
    );
  });

  it('appends an unfinished output transcription in a live call', () => {
    expect(shouldAppendEvent(transcriptionEvent('output', false), true)).toBe(
      true,
    );
  });

  it('drops an inline audio event in a live call', () => {
    expect(shouldAppendEvent(inlineMediaEvent('audio/pcm'), true)).toBe(false);
  });

  it('appends an inline audio event in a non-live call', () => {
    expect(shouldAppendEvent(inlineMediaEvent('audio/pcm'), false)).toBe(true);
  });

  it('drops an inline video event in a live call', () => {
    expect(shouldAppendEvent(inlineMediaEvent('video/mp4'), true)).toBe(false);
  });

  it('appends an inline video event in a non-live call', () => {
    expect(shouldAppendEvent(inlineMediaEvent('video/mp4'), false)).toBe(true);
  });

  it('appends text-only content in a live call', () => {
    const event = createEvent({
      invocationId: 'inv',
      author: 'live_agent',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    expect(shouldAppendEvent(event, true)).toBe(true);
  });

  it('appends a fileData reference event in a live call', () => {
    const event = createEvent({
      invocationId: 'inv',
      author: 'live_agent',
      content: {
        role: 'model',
        parts: [{fileData: {fileUri: 'gs://b/audio', mimeType: 'audio/pcm'}}],
      },
    });
    expect(shouldAppendEvent(event, true)).toBe(true);
  });
});

describe('applyLiveMultiAgentTranscriptionDefaults', () => {
  function rootWithSubAgents(): LlmAgent {
    return new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.5-flash',
      subAgents: [new LlmAgent({name: 'sub_agent', model: 'gemini-2.5-flash'})],
    });
  }

  it('defaults both transcription configs when AUDIO is a modality', () => {
    const runConfig: RunConfig = {responseModalities: [Modality.AUDIO]};
    applyLiveMultiAgentTranscriptionDefaults(rootWithSubAgents(), runConfig);
    expect(runConfig.inputAudioTranscription).toEqual({});
    expect(runConfig.outputAudioTranscription).toEqual({});
  });

  it('defaults only input transcription when AUDIO is not a modality', () => {
    const runConfig: RunConfig = {responseModalities: [Modality.TEXT]};
    applyLiveMultiAgentTranscriptionDefaults(rootWithSubAgents(), runConfig);
    expect(runConfig.inputAudioTranscription).toEqual({});
    expect(runConfig.outputAudioTranscription).toBeUndefined();
  });

  it('defaults only input transcription when modalities are undefined', () => {
    const runConfig: RunConfig = {};
    applyLiveMultiAgentTranscriptionDefaults(rootWithSubAgents(), runConfig);
    expect(runConfig.inputAudioTranscription).toEqual({});
    expect(runConfig.outputAudioTranscription).toBeUndefined();
  });

  it('never overwrites caller-provided transcription configs', () => {
    const inputConfig: AudioTranscriptionConfig = {languageCodes: ['en-US']};
    const outputConfig: AudioTranscriptionConfig = {languageCodes: ['fr-FR']};
    const runConfig: RunConfig = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: inputConfig,
      outputAudioTranscription: outputConfig,
    };
    applyLiveMultiAgentTranscriptionDefaults(rootWithSubAgents(), runConfig);
    expect(runConfig.inputAudioTranscription).toBe(inputConfig);
    expect(runConfig.outputAudioTranscription).toBe(outputConfig);
  });

  it('leaves the run config untouched when the root has no sub-agents', () => {
    const runConfig: RunConfig = {responseModalities: [Modality.AUDIO]};
    const rootWithoutSubAgents = new LlmAgent({
      name: 'solo_agent',
      model: 'gemini-2.5-flash',
    });
    applyLiveMultiAgentTranscriptionDefaults(rootWithoutSubAgents, runConfig);
    expect(runConfig.inputAudioTranscription).toBeUndefined();
    expect(runConfig.outputAudioTranscription).toBeUndefined();
  });
});

describe('Runner.runLive live-media persistence', () => {
  const APP = 'test_app_id';
  const USER = 'test_user_id';
  const SESSION = 'test_session_id';

  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let liveRequestQueue: LiveRequestQueue;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    liveRequestQueue = new LiveRequestQueue();
  });

  function createSession() {
    return sessionService.createSession({
      appName: APP,
      userId: USER,
      sessionId: SESSION,
    });
  }

  async function collect(
    generator: AsyncGenerator<Event, void, undefined>,
  ): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of generator) {
      events.push(event);
    }
    return events;
  }

  function label(event: Event): string {
    const part = event.content?.parts?.[0];
    if (part?.text) return part.text;
    if (part?.inlineData?.mimeType) return part.inlineData.mimeType;
    if (part?.fileData?.fileUri) return part.fileData.fileUri;
    if (part?.functionCall?.name) return `call:${part.functionCall.name}`;
    return 'unknown';
  }

  function hasInlineAudio(event: Event): boolean {
    return (
      event.content?.parts?.some((p) =>
        p.inlineData?.mimeType?.startsWith('audio/'),
      ) ?? false
    );
  }

  it('yields raw inline live-media events but does not persist them', async () => {
    await createSession();
    const agent = new MockLiveAgent('live_agent');
    agent.liveEvents = [
      createEvent({
        invocationId: 'live_inv',
        author: 'live_agent',
        content: {
          role: 'model',
          parts: [{inlineData: {mimeType: 'audio/pcm', data: 'AAAA'}}],
        },
      }),
      createEvent({
        invocationId: 'live_inv',
        author: 'live_agent',
        content: {role: 'model', parts: [{text: 'transcribed turn'}]},
      }),
      createEvent({
        invocationId: 'live_inv',
        author: 'live_agent',
        content: {
          role: 'model',
          parts: [{fileData: {fileUri: 'gs://b/clip', mimeType: 'audio/pcm'}}],
        },
      }),
      createEvent({
        invocationId: 'live_inv',
        author: 'live_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'do_thing', args: {}}}],
        },
      }),
    ];
    const runner = new Runner({
      appName: APP,
      agent,
      sessionService,
      artifactService,
    });

    const yielded = await collect(
      runner.runLive({userId: USER, sessionId: SESSION, liveRequestQueue}),
    );

    // Every event is streamed to the caller, including the raw inline audio.
    expect(yielded.map(label)).toEqual([
      'audio/pcm',
      'transcribed turn',
      'gs://b/clip',
      'call:do_thing',
    ]);

    // The session excludes the raw inline-audio event but keeps the rest.
    const session = await sessionService.getSession({
      appName: APP,
      userId: USER,
      sessionId: SESSION,
    });
    expect(session!.events.some(hasInlineAudio)).toBe(false);
    expect(session!.events.map(label)).toEqual([
      'transcribed turn',
      'gs://b/clip',
      'call:do_thing',
    ]);
  });

  it('populates transcription configs for a multi-agent live root', async () => {
    await createSession();
    const root = new MockLiveAgent('root_agent');
    const sub = new MockLiveAgent('sub_agent', root);
    root.subAgents.push(sub);
    root.liveEvents = [
      createEvent({
        invocationId: 'live_inv',
        author: 'root_agent',
        content: {role: 'model', parts: [{text: 'live-1'}]},
      }),
    ];
    const runner = new Runner({
      appName: APP,
      agent: root,
      sessionService,
      artifactService,
    });

    await collect(
      runner.runLive({
        userId: USER,
        sessionId: SESSION,
        liveRequestQueue,
        runConfig: {responseModalities: [Modality.AUDIO]},
      }),
    );

    expect(root.capturedContext?.runConfig?.inputAudioTranscription).toEqual(
      {},
    );
    expect(root.capturedContext?.runConfig?.outputAudioTranscription).toEqual(
      {},
    );
  });
});
