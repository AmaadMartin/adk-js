/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  Context,
  createEvent,
  createEventActions,
  createSession,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunConfig,
  Runner,
  State,
  StreamingMode,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, Mock, vi} from 'vitest';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation((config) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
      close: vi.fn(),
      runAsync: vi.fn(),
    })),
  };
});

/**
 * Installs a nested Runner stub built from `overrides`. `AgentTool` reads only
 * `sessionService`, `runAsync` and `close`, so the stub carries no more than
 * that, and the cast that says so lives here alone.
 */
function stubNestedRunner(overrides: Partial<Runner>): void {
  vi.mocked(Runner).mockImplementation(
    (config) =>
      ({
        appName: config?.appName,
        sessionService: config?.sessionService,
        close: vi.fn(),
        runAsync: vi.fn(),
        ...overrides,
      }) as unknown as Runner,
  );
}

/**
 * Runs `tool` with a stubbed nested Runner and returns the RunConfig that
 * `AgentTool` handed to that Runner.
 */
async function captureNestedRunConfig(
  tool: AgentTool,
  toolContext: Context,
): Promise<RunConfig | undefined> {
  let captured: RunConfig | undefined;

  stubNestedRunner({
    async *runAsync(params: {runConfig?: RunConfig}) {
      captured = params.runConfig;
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'done'}]},
      });
    },
  });

  await tool.runAsync({args: {request: 'go'}, toolContext});

  return captured;
}

/**
 * Runs `tool` with `args` against a stubbed nested Runner and returns the text
 * of the message that `AgentTool` sent to the wrapped agent.
 */
async function captureNestedMessageText(
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  let captured: string | undefined;

  stubNestedRunner({
    async *runAsync(params: {newMessage: Content}) {
      captured = params.newMessage.parts?.[0]?.text;
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'done'}]},
      });
    },
  });

  await tool.runAsync({args, toolContext: createToolContext()});

  return captured;
}

/**
 * Runs `tool` against a nested Runner whose `runAsync` is `runAsync`, and
 * returns that Runner's `close` mock.
 */
async function captureNestedClose(
  tool: AgentTool,
  runAsync: () => AsyncGenerator<Event>,
  toolContext: Context = createToolContext(),
): Promise<Mock> {
  const close = vi.fn();

  stubNestedRunner({close, runAsync});

  await tool.runAsync({args: {request: 'go'}, toolContext});

  return close;
}

/** Builds an AgentTool over a stub sub-agent. */
function createAgentTool(): AgentTool {
  return new AgentTool({agent: createSubAgent()});
}

/** A stub sub-agent. AgentTool only reads its name. */
function createSubAgent(): LlmAgent {
  return new LlmAgent({name: 'sub-agent'});
}

/** Builds a tool context whose invocation carries `runConfig`. */
function createToolContext(runConfig?: RunConfig): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: createSubAgent(),
      session: createSession({
        id: 'parent-session',
        appName: 'sub-agent',
        userId: 'parent-user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
      runConfig,
    }),
  });
}

describe('AgentTool', () => {
  it('propagates session context and state delta', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    vi.spyOn(mockSessionService, 'getOrCreateSession');

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      sessionService: mockSessionService,
    });

    const toolContext = new Context({
      invocationContext,
    });

    vi.spyOn(toolContext.state, 'update');

    // Setup Runner mock to return some events
    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
        actions: createEventActions({
          stateDelta: {someKey: 'someValue'},
        }),
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        close: vi.fn(),
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('hello');

    expect(mockSessionService.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'sub-agent',
        userId: 'parent-user',
        sessionId: 'parent-session',
      }),
    );

    // Verify state update called with sub-agent's state delta
    expect(toolContext.state.update).toHaveBeenCalledWith({
      someKey: 'someValue',
    });
  });

  it('reuses existing session on second invocation within the same parent session', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    vi.spyOn(mockSessionService, 'getOrCreateSession').mockResolvedValue(
      createSession({
        id: 'parent-session',
        appName: 'sub-agent',
        userId: 'parent-user',
      }),
    );

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      sessionService: mockSessionService,
    });

    const toolContext = new Context({invocationContext});

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'result'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        close: vi.fn(),
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    // Invoke twice simulating two turns in the same parent session
    await tool.runAsync({args: {request: 'first'}, toolContext});
    await tool.runAsync({args: {request: 'second'}, toolContext});

    // getOrCreateSession should be called twice, returning the existing
    // session on the second call rather than throwing a duplicate-session error
    expect(mockSessionService.getOrCreateSession).toHaveBeenCalledTimes(2);
    expect(mockSessionService.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: 'parent-session'}),
    );
  });

  it('strips thought parts from the merged result', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
    });

    const toolContext = new Context({invocationContext});

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {
          role: 'model',
          parts: [
            {text: 'reasoning about the user request', thought: true},
            {text: 'final answer'},
          ],
        },
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        close: vi.fn(),
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('final answer');
  });

  it('handles abort signal before execution', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const controller = new AbortController();

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      abortSignal: controller.signal,
    });

    const toolContext = new Context({
      invocationContext,
    });
    controller.abort();

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('');
  });

  it('does not set skipSummarization on toolContext actions when skipSummarization is true', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent, skipSummarization: true});

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
    });

    const toolContext = new Context({
      invocationContext,
    });

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'result'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        close: vi.fn(),
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    await tool.runAsync({args: {request: 'hello'}, toolContext});

    // skipSummarization must NOT be set on the parent's EventActions.
    // Setting it would cause isFinalResponse() to treat the tool-response
    // event as terminal, prematurely breaking the parent agent's run loop.
    expect(toolContext.actions.skipSummarization).toBeFalsy();
  });

  it('handles abort signal during execution', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const controller = new AbortController();

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      abortSignal: controller.signal,
    });

    const toolContext = new Context({
      invocationContext,
    });

    // Setup Runner mock to yield an event and then abort
    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
      controller.abort();
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'world'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        close: vi.fn(),
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    // The method should return undefined (void) when aborted during loop
    expect(result).toBeUndefined();
  });

  it('does not propagate temp: keys from sub-agent state delta to parent', async () => {
    const mockAgent = {name: 'sub-agent'} as unknown as LlmAgent;
    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    const updateMock = vi.fn();

    const toolContext = {
      invocationContext: {
        userId: 'parent-user',
        session: {id: 'parent-session'},
        sessionService: mockSessionService,
      },
      state: {
        toRecord: () => ({}),
        update: updateMock,
      },
    } as unknown as Context;

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'done'}]},
        actions: createEventActions({
          stateDelta: {
            normalKey: 'persistMe',
            [`${State.TEMP_PREFIX}ephemeral`]: 'dropMe',
          },
        }),
      });
    };

    vi.mocked(Runner).mockImplementation(
      (config) =>
        ({
          appName: config?.appName,
          sessionService: config?.sessionService,
          close: vi.fn(),
          runAsync: mockRunAsync,
        }) as unknown as Runner,
    );

    await tool.runAsync({args: {request: 'go'}, toolContext});

    // Only the non-temp key must reach the parent state
    expect(updateMock).toHaveBeenCalledWith({normalKey: 'persistMe'});
    expect(updateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({[`${State.TEMP_PREFIX}ephemeral`]: 'dropMe'}),
    );
  });

  it('skips state.update entirely when all delta keys are temp:', async () => {
    const mockAgent = {name: 'sub-agent'} as unknown as LlmAgent;
    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    const updateMock = vi.fn();

    const toolContext = {
      invocationContext: {
        userId: 'parent-user',
        session: {id: 'parent-session'},
        sessionService: mockSessionService,
      },
      state: {
        toRecord: () => ({}),
        update: updateMock,
      },
    } as unknown as Context;

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'done'}]},
        actions: createEventActions({
          stateDelta: {
            [`${State.TEMP_PREFIX}only`]: 'dropMe',
          },
        }),
      });
    };

    vi.mocked(Runner).mockImplementation(
      (config) =>
        ({
          appName: config?.appName,
          sessionService: config?.sessionService,
          close: vi.fn(),
          runAsync: mockRunAsync,
        }) as unknown as Runner,
    );

    await tool.runAsync({args: {request: 'go'}, toolContext});

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not propagate temp: keys from parent state when creating sub-agent session', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
      state: {
        normalKey: 'parentValue',
        [`${State.TEMP_PREFIX}tempKey`]: 'tempValue',
      },
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: mockAgent,
      session,
      pluginManager: new PluginManager([]),
      sessionService: mockSessionService,
    });

    const toolContext = new Context({
      invocationContext,
    });

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        close: vi.fn(),
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    const subAgentSession = await mockSessionService.getSession({
      appName: 'sub-agent',
      userId: 'parent-user',
      sessionId: 'parent-session',
    });

    expect(subAgentSession).toBeDefined();
    expect(subAgentSession?.state).toHaveProperty('normalKey', 'parentValue');
    expect(subAgentSession?.state).not.toHaveProperty(
      `${State.TEMP_PREFIX}tempKey`,
    );
  });

  it("forwards the caller's run config to the nested runner", async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {
      maxLlmCalls: 7,
      streamingMode: StreamingMode.SSE,
    };

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(callerRunConfig),
    );

    expect(forwarded).toMatchObject({
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
    });
  });

  it('does not forward supportCfc to the nested runner', async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {supportCfc: true, maxLlmCalls: 7};

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(callerRunConfig),
    );

    expect(forwarded?.supportCfc).toBe(false);
    expect(forwarded?.maxLlmCalls).toBe(7);
  });

  it("leaves the caller's run config unmutated", async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {supportCfc: true, maxLlmCalls: 7};
    const toolContext = createToolContext(callerRunConfig);

    const forwarded = await captureNestedRunConfig(tool, toolContext);

    expect(forwarded).toEqual({
      supportCfc: false,
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
    });
    expect(forwarded).not.toBe(callerRunConfig);
    expect(toolContext.invocationContext.runConfig).toBe(callerRunConfig);
    expect(callerRunConfig.supportCfc).toBe(true);
  });

  it('forwards no run config when the caller has none', async () => {
    const tool = createAgentTool();

    const forwarded = await captureNestedRunConfig(tool, createToolContext());

    expect(forwarded).toBeUndefined();
  });

  it('forces the nested run unary when the caller streams', async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {
      maxLlmCalls: 7,
      streamingMode: StreamingMode.SSE,
    };

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(callerRunConfig),
    );

    expect(forwarded).toEqual({
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
      supportCfc: false,
    });
    expect(callerRunConfig.streamingMode).toBe(StreamingMode.SSE);
  });

  it('drops supportCfc and forces the nested run unary together', async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {
      maxLlmCalls: 7,
      streamingMode: StreamingMode.SSE,
      supportCfc: true,
    };

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(callerRunConfig),
    );

    expect(forwarded).toEqual({
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
      supportCfc: false,
    });
    expect(callerRunConfig).toEqual({
      maxLlmCalls: 7,
      streamingMode: StreamingMode.SSE,
      supportCfc: true,
    });
  });

  it('leaves an already unary caller run config unary', async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
    };

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(callerRunConfig),
    );

    expect(forwarded).toEqual({
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
      supportCfc: false,
    });
  });

  it('runs the nested agent unary when the caller sets no streaming mode', async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {maxLlmCalls: 7};

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(callerRunConfig),
    );

    expect(forwarded).toEqual({
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
      supportCfc: false,
    });
    expect(callerRunConfig).toEqual({maxLlmCalls: 7});
  });

  it('sends a string request argument to the sub-agent verbatim', async () => {
    const text = await captureNestedMessageText(createAgentTool(), {
      request: 'find me Nike running shoes',
    });

    expect(text).toBe('find me Nike running shoes');
  });

  it('sends an empty request argument as an empty message', async () => {
    const text = await captureNestedMessageText(createAgentTool(), {
      request: '',
    });

    expect(text).toBe('');
  });

  it('sends named arguments to the sub-agent as sorted JSON', async () => {
    const text = await captureNestedMessageText(createAgentTool(), {
      brand: 'Nike',
      product: 'running shoes',
    });

    expect(text).toBe('{"brand":"Nike","product":"running shoes"}');
  });

  it('sends the same text whatever order the named arguments arrive in', async () => {
    const text = await captureNestedMessageText(createAgentTool(), {
      product: 'running shoes',
      brand: 'Nike',
    });

    expect(text).toBe('{"brand":"Nike","product":"running shoes"}');
  });

  it('sends an empty argument record as an empty JSON object', async () => {
    const text = await captureNestedMessageText(createAgentTool(), {});

    expect(text).toBe('{}');
  });

  it('sends a non-string request argument as JSON', async () => {
    const text = await captureNestedMessageText(createAgentTool(), {
      request: {city: 'Paris'},
    });

    expect(text).toBe('{"request":{"city":"Paris"}}');
  });

  it('closes the sub-runner once after a normal run', async () => {
    const close = await captureNestedClose(
      createAgentTool(),
      async function* () {
        yield createEvent({
          author: 'sub-agent',
          content: {role: 'model', parts: [{text: 'done'}]},
        });
      },
    );

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the sub-runner when the run is aborted mid-stream', async () => {
    const controller = new AbortController();
    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        agent: createSubAgent(),
        session: createSession({
          id: 'parent-session',
          appName: 'sub-agent',
          userId: 'parent-user',
        }),
        pluginManager: new PluginManager([]),
        sessionService: new InMemorySessionService(),
        abortSignal: controller.signal,
      }),
    });

    const close = await captureNestedClose(
      createAgentTool(),
      async function* () {
        yield createEvent({
          author: 'sub-agent',
          content: {role: 'model', parts: [{text: 'hello'}]},
        });
        controller.abort();
        yield createEvent({
          author: 'sub-agent',
          content: {role: 'model', parts: [{text: 'world'}]},
        });
      },
      toolContext,
    );

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the sub-runner when the nested run throws', async () => {
    const close = vi.fn();

    stubNestedRunner({
      close,
      async *runAsync() {
        yield createEvent({
          author: 'sub-agent',
          content: {role: 'model', parts: [{text: 'partial'}]},
        });
        throw new Error('sub-agent failed');
      },
    });

    await expect(
      createAgentTool().runAsync({
        args: {request: 'go'},
        toolContext: createToolContext(),
      }),
    ).rejects.toThrow('sub-agent failed');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
