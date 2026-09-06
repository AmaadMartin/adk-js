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
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunConfig,
  Runner,
  State,
  StreamingMode,
} from '@google/adk';
import {Content, Type} from '@google/genai';
import {describe, expect, it, Mock, vi} from 'vitest';
import {z} from 'zod';

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
});

/** What `AgentTool` asked of the stubbed nested runner. */
interface NestedRun {
  /** The run config it handed to the nested runner. */
  runConfig?: RunConfig;
  /** The message it handed to the nested runner. */
  newMessage?: Content;
  /** The nested runner's `close`. */
  close: Mock<() => Promise<void>>;
}

/**
 * Stubs the nested runner and records what `AgentTool` asked of it.
 *
 * @param error What the nested run fails with; it yields one text event when
 *     no error is given.
 */
function stubNestedRunner(error?: Error): NestedRun {
  const nested: NestedRun = {close: vi.fn(async () => {})};
  vi.mocked(Runner).mockImplementation(
    (config) =>
      ({
        appName: config?.appName,
        sessionService: config?.sessionService,
        close: nested.close,
        async *runAsync(params: {runConfig?: RunConfig; newMessage: Content}) {
          nested.runConfig = params.runConfig;
          nested.newMessage = params.newMessage;
          if (error) {
            throw error;
          }
          yield createEvent({
            author: 'sub-agent',
            content: {role: 'model', parts: [{text: 'done'}]},
          });
        },
      }) as unknown as Runner,
  );
  return nested;
}

/** A tool context for a caller running under `runConfig`. */
function createToolContext(options: {
  agent: LlmAgent;
  runConfig?: RunConfig;
  abortSignal?: AbortSignal;
}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: options.agent,
      session: createSession({
        id: 'parent-session',
        appName: 'sub-agent',
        userId: 'parent-user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
      runConfig: options.runConfig,
      abortSignal: options.abortSignal,
    }),
  });
}

describe('AgentTool nested run config', () => {
  it("forwards the caller's run config to the nested run", async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const runConfig: RunConfig = {
      maxLlmCalls: 7,
      a2aMetadata: {tier: 'x'},
    };
    const nested = stubNestedRunner();

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent, runConfig}),
    });

    expect(nested.runConfig).toBe(runConfig);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(nested.runConfig?.a2aMetadata).toEqual({tier: 'x'});
  });

  it('does not forward supportCfc', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const runConfig: RunConfig = {supportCfc: true, maxLlmCalls: 7};
    const nested = stubNestedRunner();

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent, runConfig}),
    });

    expect(nested.runConfig?.supportCfc).toBe(false);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(runConfig.supportCfc).toBe(true);
  });

  it('forces the nested run unary', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const runConfig: RunConfig = {
      streamingMode: StreamingMode.SSE,
      maxLlmCalls: 7,
    };
    const nested = stubNestedRunner();

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent, runConfig}),
    });

    expect(nested.runConfig?.streamingMode).toBe(StreamingMode.NONE);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(runConfig.streamingMode).toBe(StreamingMode.SSE);
  });

  it('leaves an already-unary run config unchanged', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const runConfig: RunConfig = {streamingMode: StreamingMode.NONE};
    const nested = stubNestedRunner();

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent, runConfig}),
    });

    expect(nested.runConfig).toBe(runConfig);
  });

  it('tolerates a caller with no run config', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const nested = stubNestedRunner();

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(nested.runConfig).toBeUndefined();
    expect(result).toBe('done');
  });
});

describe('AgentTool nested runner cleanup', () => {
  it('closes the nested runner after the run', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const nested = stubNestedRunner();

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(nested.close).toHaveBeenCalledTimes(1);
  });

  it('closes the nested runner when the run throws', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const nested = stubNestedRunner(new Error('nested run failed'));

    await expect(
      new AgentTool({agent}).runAsync({
        args: {request: 'go'},
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow('nested run failed');

    expect(nested.close).toHaveBeenCalledTimes(1);
  });

  it('closes the nested runner when the call is already aborted', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const nested = stubNestedRunner();

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({
        agent,
        abortSignal: AbortSignal.abort(),
      }),
    });

    expect(result).toBe('');
    expect(nested.close).toHaveBeenCalledTimes(1);
  });
});

describe('AgentTool input schema', () => {
  const inputSchema = z.object({
    city: z.string().describe('The city to report on.'),
  });

  it('builds the declaration from the input schema', () => {
    const agent = new LlmAgent({
      name: 'sub-agent',
      description: 'Reports the weather.',
      inputSchema,
    });

    const declaration = new AgentTool({agent})._getDeclaration();

    expect(declaration?.name).toBe('sub-agent');
    expect(declaration?.parameters?.type).toBe(Type.OBJECT);
    expect(declaration?.parameters?.properties).toHaveProperty('city');
  });

  it("uses the agent's description, not the schema's", () => {
    const agent = new LlmAgent({
      name: 'sub-agent',
      description: 'Reports the weather.',
      inputSchema: inputSchema.describe('A city request.'),
    });

    const declaration = new AgentTool({agent})._getDeclaration();

    expect(declaration?.description).toBe('Reports the weather.');
  });

  it('rejects arguments that violate the input schema', async () => {
    const agent = new LlmAgent({name: 'sub-agent', inputSchema});
    stubNestedRunner();

    await expect(
      new AgentTool({agent}).runAsync({
        args: {city: 42},
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow();
  });

  it('validates against a schema set directly on the agent', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    agent.inputSchema = {
      type: Type.OBJECT,
      properties: {city: {type: Type.STRING}},
      required: ['city'],
    };
    const nested = stubNestedRunner();

    await new AgentTool({agent}).runAsync({
      args: {city: 'Paris'},
      toolContext: createToolContext({agent}),
    });

    expect(nested.newMessage?.parts?.[0].text).toBe('{"city":"Paris"}');
  });

  it('passes the validated arguments as bare JSON', async () => {
    const agent = new LlmAgent({name: 'sub-agent', inputSchema});
    const nested = stubNestedRunner();

    await new AgentTool({agent}).runAsync({
      args: {city: 'Paris', unexpected: 'dropped'},
      toolContext: createToolContext({agent}),
    });

    expect(nested.newMessage?.parts?.[0].text).toBe('{"city":"Paris"}');
  });
});
