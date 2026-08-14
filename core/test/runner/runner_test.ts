/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AppendEventRequest,
  BaseCredentialService,
  Event,
  InvocationContext,
  RunConfig,
} from '@google/adk';
import {
  App,
  BaseAgent,
  BasePlugin,
  createEvent,
  createResumabilityConfig,
  determineAgentForResumption,
  InMemoryArtifactService,
  InMemoryCredentialService,
  InMemorySessionService,
  isRoutableLlmAgent,
  LlmAgent,
  Runner,
} from '@google/adk';
import type {Content, FunctionCall, FunctionResponse} from '@google/genai';
import type {MockInstance} from 'vitest';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const TEST_APP_ID = 'test_app_id';
const TEST_USER_ID = 'test_user_id';
const TEST_SESSION_ID = 'test_session_id';
const TEST_MESSAGE = 'test_message';

class MockLlmAgent extends LlmAgent {
  /** The context this agent was last run with, recorded for assertions. */
  lastInvocationContext?: InvocationContext;

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
    this.lastInvocationContext = context;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'Test LLM response'}]},
    });
  }
}

/** Records how many session events the agent sees on each invocation. */
class EventCountingAgent extends MockLlmAgent {
  readonly seenEventCounts: number[] = [];

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.seenEventCounts.push(context.session.events.length);
    yield* super.runAsyncImpl(context);
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

  describe('graph-workflow node events', () => {
    /** A session holding the given events. */
    async function sessionWith(sessionId: string, events: Event[]) {
      const session = await sessionService.createSession({
        appName: TEST_APP_ID,
        userId: TEST_USER_ID,
        sessionId,
      });
      for (const event of events) {
        await sessionService.appendEvent({session, event});
      }
      return session;
    }

    /**
     * An event from a node that is not an agent: authored by the node's own
     * name, stamped with a node path. It is not in the agent tree, and never
     * can be.
     */
    function nodeEvent(author: string, text: string) {
      return createEvent({
        invocationId: 'inv1',
        author,
        nodeInfo: {path: `root_agent.${author}`},
        content: {role: 'model', parts: [{text}]},
      });
    }

    it('does not warn about a node that is not in the agent tree', async () => {
      // Every HITL resume replays node events, so this fired on the happy
      // path of any workflow that pauses for input.
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      determineAgentForResumption(
        await sessionWith('session_workflow_node', [
          nodeEvent('step1', 'Enter a number:'),
        ]),
        rootAgent,
        createResumabilityConfig({isResumable: true}),
      );

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not warn when a resumed function call came from a node', async () => {
      // A HITL interrupt event carries no author, so the workflow engine
      // stamps the node name on it. Replying to it with a structured resume
      // sends Case 1 looking for an agent named after the node.
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const interrupt = createEvent({
        invocationId: 'inv1',
        author: 'gate',
        nodeInfo: {path: 'root_agent.gate'},
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'interrupt_1',
                name: 'adk_request_input',
                args: {},
              },
            },
          ],
        },
      });
      const reply = createEvent({
        invocationId: 'inv2',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'interrupt_1',
                name: 'adk_request_input',
                response: {value: 21},
              },
            },
          ],
        },
      });

      const result = determineAgentForResumption(
        await sessionWith('session_workflow_interrupt', [interrupt, reply]),
        rootAgent,
        createResumabilityConfig({isResumable: true}),
      );

      expect(warn).not.toHaveBeenCalled();
      expect(result.name).toBe('root_agent');
      warn.mockRestore();
    });

    it('still resolves an agent that a node wrapped', async () => {
      // The LLMAgentWrapper shape: the node yields the agent's own events, so
      // the author is a real agent even though the event carries a node path.
      // Suppressing the warning must not cost us the lookup.
      const result = determineAgentForResumption(
        await sessionWith('session_workflow_wrapped_agent', [
          nodeEvent('sub_agent1', 'Sub agent response'),
        ]),
        rootAgent,
        createResumabilityConfig({isResumable: true}),
      );

      expect(result.name).toBe('sub_agent1');
    });

    it('still warns about a genuinely unknown agent', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      // No node path: this really is an agent nobody can find.
      const session = await sessionWith('session_unknown_agent', [
        createEvent({
          invocationId: 'inv1',
          author: 'ghost_agent',
          content: {role: 'model', parts: [{text: 'boo'}]},
        }),
      ]);

      determineAgentForResumption(
        session,
        rootAgent,
        createResumabilityConfig({isResumable: true}),
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Event from an unknown agent: ghost_agent'),
      );
      warn.mockRestore();
    });

    it('still warns about a resumed function call from an unknown agent', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const callEvent = createEvent({
        invocationId: 'inv1',
        author: 'ghost_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call_1', name: 'test_func', args: {}}}],
        },
      });
      const responseEvent = createEvent({
        invocationId: 'inv2',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'test_func',
                response: {},
              },
            },
          ],
        },
      });

      determineAgentForResumption(
        await sessionWith('session_unknown_function_response', [
          callEvent,
          responseEvent,
        ]),
        rootAgent,
        createResumabilityConfig({isResumable: true}),
      );

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Function response from an unknown agent: ghost_agent',
        ),
      );
      warn.mockRestore();
    });
  });

  it('should return root agent when function call author is not found in agent tree', async () => {
    const functionCall: FunctionCall = {
      id: 'func_999',
      name: 'test_func',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_999',
      name: 'test_func',
      response: {},
    };

    const callEvent = createEvent({
      invocationId: 'inv1',
      author: 'removed_sub_agent',
      content: {role: 'model', parts: [{functionCall}]},
    });

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    await sessionService.appendEvent({session: session, event: callEvent});

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{functionResponse}]},
    })) {
      events.push(event);
    }

    expect(events[0].author).toBe('root_agent');
  });

  it('should fall back to Case 2 when function call event author is undefined', async () => {
    const functionCall: FunctionCall = {
      id: 'func_777',
      name: 'test_func',
      args: {},
    };
    const functionResponse: FunctionResponse = {
      id: 'func_777',
      name: 'test_func',
      response: {},
    };

    const callEvent = createEvent({
      invocationId: 'inv1',
      author: undefined,
      content: {role: 'model', parts: [{functionCall}]},
    });

    const subEvent = createEvent({
      invocationId: 'inv2',
      author: 'sub_agent1',
      content: {role: 'model', parts: [{text: 'Hello from sub1'}]},
    });

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    await sessionService.appendEvent({session: session, event: callEvent});
    await sessionService.appendEvent({session: session, event: subEvent});

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

  it('should memoize visited authors during backward scan so findSubAgent is called exactly once per unique author', async () => {
    const spy = vi.spyOn(rootAgent, 'findSubAgent');
    const inputEvents: Event[] = [];
    for (let i = 0; i < 100; i++) {
      inputEvents.push(
        createEvent({
          invocationId: `inv-sub1-${i}`,
          author: 'sub_agent1',
          content: {role: 'model', parts: [{text: `Response ${i}`}]},
        }),
      );
    }
    for (let i = 0; i < 100; i++) {
      inputEvents.push(
        createEvent({
          invocationId: `inv-non-${i}`,
          author: 'non_transferable',
          content: {role: 'model', parts: [{text: `Response ${i}`}]},
        }),
      );
    }
    for (let i = 0; i < 100; i++) {
      inputEvents.push(
        createEvent({
          invocationId: `inv-unk-${i}`,
          author: 'unknown_agent',
          content: {role: 'model', parts: [{text: `Response ${i}`}]},
        }),
      );
    }

    const events = await runTest(inputEvents);
    expect(events[0].author).toBe('sub_agent1');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledWith('unknown_agent');
    expect(spy).toHaveBeenCalledWith('non_transferable');
    expect(spy).toHaveBeenCalledWith('sub_agent1');
  });

  it('should efficiently determine resumption agent in long sessions with 5,000+ events without performance lag', async () => {
    const inputEvents: Event[] = [];
    inputEvents.push(
      createEvent({
        invocationId: 'inv-early',
        author: 'sub_agent1',
        content: {role: 'model', parts: [{text: 'Early sub agent response'}]},
      }),
    );
    for (let i = 0; i < 5000; i++) {
      const author =
        i % 3 === 0
          ? 'non_transferable'
          : i % 3 === 1
            ? 'unknown_agent'
            : 'user';
      inputEvents.push(
        createEvent({
          invocationId: `inv-long-${i}`,
          author,
          content: {
            role: author === 'user' ? 'user' : 'model',
            parts: [{text: `Event ${i}`}],
          },
        }),
      );
    }

    const startTime = Date.now();
    const events = await runTest(inputEvents);
    const durationMs = Date.now() - startTime;

    expect(events[0].author).toBe('sub_agent1');
    expect(durationMs).toBeLessThan(6500);
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

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const persistedEvent = session!.events[1];
    expect(persistedEvent.content!.parts![0].text).toEqual(
      MockPlugin.ON_EVENT_CALLBACK_MSG,
    );
    expect(persistedEvent.author).toEqual('test_agent');
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
      for await (const _event of runner.runAsync({
        userId,
        sessionId,
        newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
      })) {
        // Drain the stream; the runner is expected to throw before yielding.
      }
      return null;
    } catch (e) {
      return e as Error;
    }
  }

  it('should throw clear error when appName is not configured in runner', async () => {
    const agent = new MockLlmAgent('test_agent');
    // Intentionally omitting appName to test error handling. `appName` is
    // optional on RunnerConfig (it can come from `app.name`), so this is only
    // reported at runtime, when the session lookup fails.
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

  it('should name the searched app and user in the session not found error', async () => {
    const agent = new MockLlmAgent('test_agent');

    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: agent,
      sessionService,
      artifactService,
    });

    // The session exists, but under a different app namespace.
    const session = await sessionService.createSession({
      appName: 'other_app_id',
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const error = await runTestExpectingError(runner, session.id, TEST_USER_ID);

    expect(error).not.toBeNull();
    expect(error?.message).toContain(`Session not found: ${session.id}`);
    expect(error?.message).toContain(`appName=${TEST_APP_ID}`);
    expect(error?.message).toContain(`userId=${TEST_USER_ID}`);
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

describe('Runner artifact saving (`saveInputBlobsAsArtifacts`)', () => {
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

  it('testSaveArtifacts_modelAccessibleUri_attachesFileData', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    vi.spyOn(artifactService, 'getArtifactVersion').mockResolvedValue({
      version: 0,
      canonicalUri: 'gs://test-bucket/file.pdf/versions/0',
      mimeType: 'application/pdf',
    });

    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'JVBERi0xLjQ...',
            displayName: 'file.pdf',
          },
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // Consume stream
    }

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    expect(updatedSession!.events).toHaveLength(2);
    const userEvent = updatedSession!.events[0];
    expect(userEvent.content!.parts).toEqual([
      {text: '[Uploaded Artifact: "file.pdf"]'},
      {
        fileData: {
          fileUri: 'gs://test-bucket/file.pdf/versions/0',
          mimeType: 'application/pdf',
          displayName: 'file.pdf',
        },
      },
    ]);
  });

  it('testSaveArtifacts_nonAccessibleUri_onlyAttachesPlaceholder', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    vi.spyOn(artifactService, 'getArtifactVersion').mockResolvedValue({
      version: 0,
      canonicalUri: 'file:///tmp/file.pdf',
      mimeType: 'application/pdf',
    });

    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'JVBERi0xLjQ...',
            displayName: 'file.pdf',
          },
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // Consume stream
    }

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const userEvent = updatedSession!.events[0];
    expect(userEvent.content!.parts).toEqual([
      {text: '[Uploaded Artifact: "file.pdf"]'},
    ]);
  });

  it('testSaveArtifacts_immutability_doesNotMutateInput', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const inlineDataObj = {
      mimeType: 'application/pdf',
      data: 'JVBERi0xLjQ...',
      displayName: 'file.pdf',
    };

    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: inlineDataObj,
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // Consume stream
    }

    expect(newMessage.parts![0].inlineData).toBeDefined();
    expect(newMessage.parts![0].inlineData).toEqual(inlineDataObj);
    expect(newMessage.parts![0].text).toBeUndefined();
  });

  it('testSaveArtifacts_displayNameResolution', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    vi.spyOn(artifactService, 'getArtifactVersion').mockResolvedValue({
      version: 0,
      canonicalUri: 'gs://test-bucket/doc/versions/0',
    });

    // Test with displayName and without displayName
    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'JVBERi0xLjQ...',
            displayName: 'named_doc.pdf',
          },
        },
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'iVBOR...',
          },
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // Consume stream
    }

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const parts = updatedSession!.events[0].content!.parts!;
    expect(parts[0]).toEqual({text: '[Uploaded Artifact: "named_doc.pdf"]'});
    expect(parts[1].fileData?.displayName).toBe('named_doc.pdf');

    expect(parts[2].text).toMatch(/\[Uploaded Artifact: "artifact_.+_1"\]/);
    expect(parts[3].fileData?.displayName).toMatch(/artifact_.+_1/);
  });

  it('testSaveArtifacts_errorResiliency_retainsOriginalPart', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    vi.spyOn(artifactService, 'saveArtifact').mockImplementation(
      async (req) => {
        if (req.filename === 'good.pdf') {
          return 0;
        }
        throw new Error('simulated save error for bad.png');
      },
    );

    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'JVBERi0xLjQ...',
            displayName: 'good.pdf',
          },
        },
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'bad_data',
            displayName: 'bad.png',
          },
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // Consume stream
    }

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const parts = updatedSession!.events[0].content!.parts!;
    expect(parts[0]).toEqual({text: '[Uploaded Artifact: "good.pdf"]'});
    expect(parts[1].inlineData).toEqual({
      mimeType: 'image/png',
      data: 'bad_data',
      displayName: 'bad.png',
    });
  });

  it('should handle getArtifactVersion errors and missing version metadata gracefully during saveArtifacts', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    // Case 1: getArtifactVersion throws an error
    vi.spyOn(artifactService, 'getArtifactVersion').mockRejectedValueOnce(
      new Error('version lookup failure'),
    );

    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'data',
            displayName: 'file1.pdf',
          },
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // Consume stream
    }

    let updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    let userEvents = updatedSession!.events.filter((e) => e.author === 'user');
    expect(userEvents[0].content!.parts).toEqual([
      {text: '[Uploaded Artifact: "file1.pdf"]'},
    ]);

    // Case 2: getArtifactVersion returns undefined or no canonicalUri
    vi.spyOn(artifactService, 'getArtifactVersion').mockResolvedValueOnce(
      undefined,
    );

    const newMessage2: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'data',
            displayName: 'file2.pdf',
          },
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: newMessage2,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // Consume stream
    }

    updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    userEvents = updatedSession!.events.filter((e) => e.author === 'user');
    expect(userEvents[1].content!.parts).toEqual([
      {text: '[Uploaded Artifact: "file2.pdf"]'},
    ]);
  });
});

describe('Runner getSessionConfig forwarding', () => {
  const SEED_TIMESTAMPS = [1000, 1001, 1002];
  const NEW_MESSAGE: Content = {role: 'user', parts: [{text: TEST_MESSAGE}]};

  let sessionService: InMemorySessionService;
  let agent: EventCountingAgent;
  let runner: Runner;
  let getSessionSpy: MockInstance<InMemorySessionService['getSession']>;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    agent = new EventCountingAgent('test_agent');
    runner = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService: new InMemoryArtifactService(),
    });

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    for (const [index, timestamp] of SEED_TIMESTAMPS.entries()) {
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: `seed-${index}`,
          author: 'user',
          timestamp,
          content: {role: 'user', parts: [{text: `seed ${index}`}]},
        }),
      });
    }

    getSessionSpy = vi.spyOn(sessionService, 'getSession');
  });

  async function run(runConfig?: RunConfig): Promise<void> {
    for await (const _event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: NEW_MESSAGE,
      runConfig,
    })) {
      // Consume stream
    }
  }

  it('forwards getSessionConfig to the session service', async () => {
    await run({getSessionConfig: {numRecentEvents: 1}});

    expect(getSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({config: {numRecentEvents: 1}}),
    );
  });

  it('bounds the events loaded for the invocation', async () => {
    await run({getSessionConfig: {numRecentEvents: 1}});

    // The single fetched event plus the new user message.
    expect(agent.seenEventCounts).toEqual([2]);
  });

  it('forwards afterTimestamp', async () => {
    await run({getSessionConfig: {afterTimestamp: SEED_TIMESTAMPS[2]}});

    expect(getSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({config: {afterTimestamp: SEED_TIMESTAMPS[2]}}),
    );
    expect(agent.seenEventCounts).toEqual([2]);
  });

  it('does not truncate stored history', async () => {
    await run({getSessionConfig: {numRecentEvents: 1}});
    getSessionSpy.mockRestore();

    const stored = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    expect(stored!.events).toHaveLength(SEED_TIMESTAMPS.length + 2);
    expect(
      stored!.events.filter(
        (event) =>
          event.author === 'user' &&
          event.content?.parts?.[0].text === TEST_MESSAGE,
      ),
    ).toHaveLength(1);
  });

  it('leaves config undefined when getSessionConfig is absent', async () => {
    await run();

    expect(getSessionSpy.mock.calls[0][0].config).toBeUndefined();
    // The full seeded history plus the new user message.
    expect(agent.seenEventCounts).toEqual([SEED_TIMESTAMPS.length + 1]);
  });
});

/** A session service that only writes events out when it is drained. */
class BufferingSessionService extends InMemorySessionService {
  readonly pending: Event[] = [];
  readonly written: Event[] = [];

  override async appendEvent(request: AppendEventRequest): Promise<Event> {
    const event = await super.appendEvent(request);
    this.pending.push(event);
    return event;
  }

  override async flush(): Promise<void> {
    this.written.push(...this.pending);
    this.pending.length = 0;
  }
}

describe('Runner session service flush', () => {
  let sessionService: InMemorySessionService;
  let runner: Runner;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    runner = new Runner({
      appName: TEST_APP_ID,
      agent: new MockLlmAgent('test_agent'),
      sessionService,
    });
  });

  async function runToCompletion(sessionId: string): Promise<void> {
    for await (const _ of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId,
      newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
    })) {
      // Consume stream
    }
  }

  it('drains the session service once per completed invocation', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const flushSpy = vi.spyOn(sessionService, 'flush');

    await runToCompletion(session.id);

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('drains the session service after the last appendEvent', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const appendEventSpy = vi.spyOn(sessionService, 'appendEvent');
    const flushSpy = vi.spyOn(sessionService, 'flush');

    await runToCompletion(session.id);

    expect(appendEventSpy.mock.invocationCallOrder.length).toBeGreaterThan(0);
    expect(flushSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...appendEventSpy.mock.invocationCallOrder),
    );
  });

  it('drains the session service once per invocation, not once per runner', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const flushSpy = vi.spyOn(sessionService, 'flush');

    await runToCompletion(session.id);
    await runToCompletion(session.id);

    expect(flushSpy).toHaveBeenCalledTimes(2);
  });

  it('drains the session service when the invocation throws', async () => {
    const flushSpy = vi.spyOn(sessionService, 'flush');

    await expect(runToCompletion('non_existent_session_id')).rejects.toThrow(
      'Session not found: non_existent_session_id',
    );

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('drains the session service before runEphemeral deletes the session', async () => {
    const flushSpy = vi.spyOn(sessionService, 'flush');
    const deleteSessionSpy = vi.spyOn(sessionService, 'deleteSession');

    for await (const _ of runner.runEphemeral({
      userId: TEST_USER_ID,
      newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
    })) {
      // Consume stream
    }

    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSessionSpy.mock.invocationCallOrder[0],
    );
  });

  it('drains a buffering session service by the end of the invocation', async () => {
    const bufferingService = new BufferingSessionService();
    const bufferingRunner = new Runner({
      appName: TEST_APP_ID,
      agent: new MockLlmAgent('test_agent'),
      sessionService: bufferingService,
    });

    for await (const _ of bufferingRunner.runEphemeral({
      userId: TEST_USER_ID,
      newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
    })) {
      // Consume stream
    }

    expect(bufferingService.pending).toEqual([]);
    expect(bufferingService.written.map((e) => e.author)).toEqual([
      'user',
      'test_agent',
    ]);
  });
});

describe('Runner credential service', () => {
  it('passes the credential service it was configured with into the invocation context', async () => {
    let observedCredentialService: BaseCredentialService | undefined;

    class ContextCapturingAgent extends BaseAgent {
      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        observedCredentialService = context.credentialService;
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {role: 'model', parts: [{text: 'ok'}]},
        });
      }

      protected override async *runLiveImpl(
        _context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {}
    }

    const credentialService = new InMemoryCredentialService();
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const runner = new Runner({
      appName: TEST_APP_ID,
      agent: new ContextCapturingAgent({name: 'capturing_agent'}),
      sessionService,
      credentialService,
    });

    for await (const _ of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage: {role: 'user', parts: [{text: TEST_MESSAGE}]},
    })) {
      // Drain the stream so the agent runs to completion.
    }

    // The agent observes its own context, which BaseAgent.runAsync builds by
    // spreading the runner's context, so this pins the whole chain.
    expect(observedCredentialService).toBe(credentialService);
  });
});

describe('Runner internalization and saveInputBlobsAsArtifacts', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;
  let runner: Runner;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    const rootAgent = new MockLlmAgent('root_agent');
    runner = new Runner({
      appName: TEST_APP_ID,
      agent: rootAgent,
      sessionService,
      artifactService,
    });
    await sessionService.createSession({
      sessionId: TEST_SESSION_ID,
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
    });
  });

  it('should internalize runConfig and save inline data blobs via invocationContext.artifactService', async () => {
    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'text/plain',
            data: 'SGVsbG8gV29ybGQ=',
          },
        },
        {
          text: 'Regular text part',
        },
      ],
    };

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage,
      runConfig: {
        saveInputBlobsAsArtifacts: true,
      },
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    expect(session).toBeDefined();
    const userEvent = session!.events[0];
    expect(userEvent.author).toBe('user');
    expect(userEvent.content?.parts?.[0].text).toMatch(
      /^\[Uploaded Artifact: "artifact_e-[a-z0-9-]+_0"\]$/,
    );
    expect(userEvent.content?.parts?.[1].text).toBe('Regular text part');

    const keys = await artifactService.listArtifactKeys({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^artifact_e-[a-z0-9-]+_0$/);
  });

  it('should skip saving artifacts if artifactService is undefined', async () => {
    const runnerWithoutArtifacts = new Runner({
      appName: TEST_APP_ID,
      agent: new MockLlmAgent('root_agent'),
      sessionService,
    });

    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'text/plain',
            data: 'SGVsbG8=',
          },
        },
      ],
    };

    for await (const _ of runnerWithoutArtifacts.runAsync({
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      newMessage,
      runConfig: {
        saveInputBlobsAsArtifacts: true,
      },
    })) {
      // Consume stream
    }

    const session = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    expect(session!.events[0].content?.parts?.[0].inlineData).toBeDefined();
  });
});

describe('Runner artifact scope and context propagation', () => {
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
      agent,
      sessionService,
      artifactService,
    });
  });

  it('should pass the session composite key to saveArtifact', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const saveSpy = vi.spyOn(artifactService, 'saveArtifact');

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {text: 'Check this image'},
          {inlineData: {mimeType: 'image/png', data: 'aW1hZ2VkYXRh'}},
        ],
      },
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // consume generator
    }

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: TEST_APP_ID,
        userId: TEST_USER_ID,
        sessionId: TEST_SESSION_ID,
        filename: expect.stringMatching(/^artifact_.*_1$/),
        artifact: {inlineData: {mimeType: 'image/png', data: 'aW1hZ2VkYXRh'}},
      }),
    );
  });

  it('should expose the placeholder message, not the raw blob, as invocation userContent', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const originalMessage: Content = {
      role: 'user',
      parts: [
        {text: 'Check this image'},
        {inlineData: {mimeType: 'image/png', data: 'aW1hZ2VkYXRh'}},
      ],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: originalMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // consume generator
    }

    // The context the agent (and anything reading ReadonlyContext.userContent)
    // sees must not still hold the base64 payload.
    const userContent = agent.lastInvocationContext?.userContent;
    expect(userContent).toBeDefined();
    expect(userContent!.parts![1].inlineData).toBeUndefined();
    expect(userContent!.parts![1].text).toMatch(
      /^\[Uploaded Artifact: "artifact_.*_1"\]$/,
    );
  });

  it('should not save artifacts or replace inlineData if saveInputBlobsAsArtifacts is false', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const saveSpy = vi.spyOn(artifactService, 'saveArtifact');

    const originalMessage: Content = {
      role: 'user',
      parts: [{inlineData: {mimeType: 'image/png', data: 'aW1hZ2VkYXRh'}}],
    };

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: originalMessage,
      runConfig: {saveInputBlobsAsArtifacts: false},
    })) {
      events.push(event);
    }

    expect(saveSpy).not.toHaveBeenCalled();
    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const userEvent = updatedSession!.events[0];
    expect(userEvent.content?.parts![0].inlineData).toBeDefined();
  });

  it('should return message unchanged when parts is empty or contains no inlineData', async () => {
    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const saveSpy = vi.spyOn(artifactService, 'saveArtifact');

    const originalMessage: Content = {
      role: 'user',
      parts: [{text: 'Only text part'}],
    };

    for await (const _ of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: originalMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // consume generator
    }

    expect(saveSpy).not.toHaveBeenCalled();
    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const userEvent = updatedSession!.events[0];
    expect(userEvent.content?.parts![0]).toEqual({text: 'Only text part'});
    // Nothing was replaced, so the very same object is handed back - no
    // needless Content/parts allocation on the blob-free path.
    expect(agent.lastInvocationContext?.userContent).toBe(originalMessage);
  });

  it('should return message unchanged when artifactService is not defined', async () => {
    const runnerWithoutArtifacts = new Runner({
      appName: TEST_APP_ID,
      agent,
      sessionService,
      artifactService: undefined,
    });

    const session = await sessionService.createSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });

    const originalMessage: Content = {
      role: 'user',
      parts: [{inlineData: {mimeType: 'image/png', data: 'aW1hZ2VkYXRh'}}],
    };

    for await (const _ of runnerWithoutArtifacts.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: originalMessage,
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      // consume generator
    }

    const updatedSession = await sessionService.getSession({
      appName: TEST_APP_ID,
      userId: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
    });
    const userEvent = updatedSession!.events[0];
    expect(userEvent.content?.parts![0].inlineData).toBeDefined();
  });
});
