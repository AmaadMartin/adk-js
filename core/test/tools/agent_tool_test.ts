/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, Schema} from '@google/genai';
import {Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import type {Event, RunConfig} from '../../src/index.js';
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
  Runner,
  SequentialAgent,
  State,
  StreamingMode,
} from '../../src/index.js';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn((config) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: vi.fn(),
    })),
  };
});

/** Makes the mocked sub-agent run yield `events`, in order. */
function mockSubAgentRun(events: Event[]) {
  vi.mocked(Runner).mockImplementation(
    (config) =>
      ({
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: async function* () {
          yield* events;
        },
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

  vi.mocked(Runner).mockImplementation(
    (config) =>
      ({
        appName: config?.appName,
        sessionService: config?.sessionService,
        async *runAsync(params: {runConfig?: RunConfig}) {
          captured = params.runConfig;
          yield createEvent({
            author: 'sub-agent',
            content: {role: 'model', parts: [{text: 'done'}]},
          });
        },
      }) as unknown as Runner,
  );

  await tool.runAsync({args: {request: 'go'}, toolContext});

  return captured;
}

/** Builds an AgentTool over a stub sub-agent. */
function createAgentTool(): AgentTool {
  return new AgentTool({agent: createSubAgent()});
}

/** A stub sub-agent. AgentTool only reads its name. */
function createSubAgent(): LlmAgent {
  return new LlmAgent({name: 'sub-agent'});
}

/** A tool context whose parent invocation runs `agent` with `runConfig`. */
function createToolContext(agent: LlmAgent, runConfig?: RunConfig): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({
        id: 'parent-session',
        appName: agent.name,
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

  it('returns the error message when the final event has no content parts', async () => {
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
        errorMessage: 'A2A request failed: 503',
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('A2A request failed: 503');
  });

  it('returns the error message when the final content is only thoughts', async () => {
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
        errorMessage: 'A2A request failed: 503',
      });
      yield createEvent({
        author: 'sub-agent',
        content: {
          role: 'model',
          parts: [{text: 'thinking', thought: true}, {text: ''}],
        },
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('A2A request failed: 503');
  });

  it('returns an empty string when there is no content and no error message', async () => {
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
      yield createEvent({author: 'sub-agent'});
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('');
  });

  it("prefers the sub-agent's content over an earlier error message", async () => {
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
        errorMessage: 'transient model error',
      });
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'final answer'}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('final answer');
  });

  it('returns an empty string for empty output under an output schema', async () => {
    const subAgent = new LlmAgent({
      name: 'sub-agent',
      model: 'gemini-2.5-flash',
      outputSchema: z.object({answer: z.string()}),
    });

    const tool = new AgentTool({agent: subAgent});

    const session = createSession({
      id: 'parent-session',
      appName: 'sub-agent',
      userId: 'parent-user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: subAgent,
      session,
      pluginManager: new PluginManager([]),
    });

    const toolContext = new Context({invocationContext});

    const mockRunAsync = async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'thinking', thought: true}]},
      });
    };

    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    });

    const result = await tool.runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('');
  });

  it('returns the last content when a state-only event ends the run', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    const toolContext = createToolContext(agent);
    vi.spyOn(toolContext.state, 'update');

    // The trailing event has the shape BaseAgent emits when an after-agent
    // callback only mutates state.
    mockSubAgentRun([
      createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'the real answer'}]},
      }),
      createEvent({
        author: 'sub-agent',
        actions: createEventActions({stateDelta: {reviewed: 'true'}}),
      }),
    ]);

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('the real answer');
    expect(toolContext.state.update).toHaveBeenCalledWith({reviewed: 'true'});
  });

  it('returns the last content when an error-message event ends the run', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    mockSubAgentRun([
      createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'the real answer'}]},
      }),
      createEvent({
        author: 'sub-agent',
        errorMessage: 'MALFORMED_FUNCTION_CALL',
      }),
    ]);

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(agent),
    });

    expect(result).toBe('the real answer');
  });

  it('returns an empty string when no event carried content', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    mockSubAgentRun([
      createEvent({
        author: 'sub-agent',
        actions: createEventActions({stateDelta: {reviewed: 'true'}}),
      }),
    ]);

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(agent),
    });

    expect(result).toBe('');
  });

  it('returns the newer content when two content events end the run', async () => {
    const agent = new LlmAgent({name: 'sub-agent'});
    mockSubAgentRun([
      createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'first answer'}]},
      }),
      createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'second answer'}]},
      }),
    ]);

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(agent),
    });

    expect(result).toBe('second answer');
  });

  it("forwards the caller's run config to the nested runner", async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {
      maxLlmCalls: 7,
      streamingMode: StreamingMode.SSE,
    };

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(createSubAgent(), callerRunConfig),
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
      createToolContext(createSubAgent(), callerRunConfig),
    );

    expect(forwarded?.supportCfc).toBe(false);
    expect(forwarded?.maxLlmCalls).toBe(7);
  });

  it("leaves the caller's run config unmutated", async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {supportCfc: true, maxLlmCalls: 7};
    const toolContext = createToolContext(createSubAgent(), callerRunConfig);

    const forwarded = await captureNestedRunConfig(tool, toolContext);

    expect(forwarded).toEqual({supportCfc: false, maxLlmCalls: 7});
    expect(forwarded).not.toBe(callerRunConfig);
    expect(toolContext.invocationContext.runConfig).toBe(callerRunConfig);
    expect(callerRunConfig.supportCfc).toBe(true);
  });

  it('forwards no run config when the caller has none', async () => {
    const tool = createAgentTool();

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(createSubAgent()),
    );

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
      createToolContext(createSubAgent(), callerRunConfig),
    );

    expect(forwarded).toEqual({
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
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
      createToolContext(createSubAgent(), callerRunConfig),
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

  it('forwards a unary caller run config as the same object', async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {
      maxLlmCalls: 7,
      streamingMode: StreamingMode.NONE,
    };

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(createSubAgent(), callerRunConfig),
    );

    expect(forwarded).toBe(callerRunConfig);
  });

  it('forwards a caller run config with no streaming mode as the same object', async () => {
    const tool = createAgentTool();
    const callerRunConfig: RunConfig = {maxLlmCalls: 7};

    const forwarded = await captureNestedRunConfig(
      tool,
      createToolContext(createSubAgent(), callerRunConfig),
    );

    expect(forwarded).toBe(callerRunConfig);
  });
});

describe('AgentTool with composite agents', () => {
  const REQUEST_PARAMETERS: Schema = {
    type: Type.OBJECT,
    properties: {request: {type: Type.STRING}},
    required: ['request'],
  };

  const QUERY_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
      query: {type: Type.STRING},
      language: {type: Type.STRING},
    },
    required: ['query', 'language'],
  };

  /**
   * Runs `tool` against a mocked Runner and returns the message text the
   * sub-agent received.
   */
  async function captureMessageText(
    tool: AgentTool,
    agent: SequentialAgent,
    args: Record<string, unknown>,
  ): Promise<string | undefined> {
    let capturedMessage: Content | undefined;
    const mockRunAsync = async function* (request: {newMessage: Content}) {
      capturedMessage = request.newMessage;
      yield createEvent({
        author: agent.name,
        content: {role: 'model', parts: [{text: 'done'}]},
      });
    };

    vi.mocked(Runner).mockImplementation(
      (config) =>
        ({
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync: mockRunAsync,
        }) as unknown as Runner,
    );

    const session = createSession({
      id: 'parent-session',
      appName: agent.name,
      userId: 'parent-user',
    });

    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        agent,
        session,
        pluginManager: new PluginManager([]),
        sessionService: new InMemorySessionService(),
      }),
    });

    await tool.runAsync({args, toolContext});

    return capturedMessage?.parts?.[0]?.text;
  }

  it("exposes the first sub-agent's input schema when wrapping a SequentialAgent", () => {
    const sequence = new SequentialAgent({
      name: 'sequence',
      description: 'Process the query through multiple steps',
      subAgents: [
        new LlmAgent({name: 'first_agent', inputSchema: QUERY_SCHEMA}),
        new LlmAgent({name: 'second_agent'}),
      ],
    });

    const declaration = new AgentTool({agent: sequence})._getDeclaration();

    expect(declaration.name).toBe('sequence');
    expect(declaration.description).toBe(
      'Process the query through multiple steps',
    );
    expect(declaration.parameters).toEqual(QUERY_SCHEMA);
    expect(declaration.parameters?.properties).not.toHaveProperty('request');
  });

  it('falls back to the request parameter when no sub-agent has an input schema', () => {
    const sequence = new SequentialAgent({
      name: 'sequence',
      description: 'A sequence without schemas',
      subAgents: [
        new LlmAgent({name: 'first_agent'}),
        new LlmAgent({name: 'second_agent'}),
      ],
    });

    const declaration = new AgentTool({agent: sequence})._getDeclaration();

    expect(declaration.parameters).toEqual(REQUEST_PARAMETERS);
    expect(declaration.parameters?.properties).not.toHaveProperty('query');
  });

  it('resolves the input schema through nested composite agents', () => {
    const innerSchema: Schema = {
      type: Type.OBJECT,
      properties: {deep_query: {type: Type.STRING}},
      required: ['deep_query'],
    };
    const outerSequence = new SequentialAgent({
      name: 'outer_sequence',
      description: 'An outer sequence',
      subAgents: [
        new SequentialAgent({
          name: 'inner_sequence',
          description: 'An inner sequence',
          subAgents: [
            new LlmAgent({name: 'inner_agent', inputSchema: innerSchema}),
          ],
        }),
      ],
    });

    const declaration = new AgentTool({agent: outerSequence})._getDeclaration();

    expect(declaration.parameters).toEqual(innerSchema);
    expect(declaration.parameters?.properties).not.toHaveProperty('request');
  });

  it('falls back to the request parameter for an empty composite agent', () => {
    const emptySequence = new SequentialAgent({
      name: 'empty_sequence',
      description: 'An empty sequence',
      subAgents: [],
    });

    const declaration = new AgentTool({agent: emptySequence})._getDeclaration();

    expect(declaration.parameters).toEqual(REQUEST_PARAMETERS);
  });

  it('sends the args as JSON when the first sub-agent has an input schema', async () => {
    const sequence = new SequentialAgent({
      name: 'sequence',
      description: 'Process the query through multiple steps',
      subAgents: [
        new LlmAgent({name: 'first_agent', inputSchema: QUERY_SCHEMA}),
        new LlmAgent({name: 'second_agent'}),
      ],
    });
    const args = {query: 'hi', language: 'en'};

    const text = await captureMessageText(
      new AgentTool({agent: sequence}),
      sequence,
      args,
    );

    expect(text).toBe(JSON.stringify(args));
  });

  it('sends the request string when no sub-agent has an input schema', async () => {
    const sequence = new SequentialAgent({
      name: 'sequence',
      description: 'A sequence without schemas',
      subAgents: [new LlmAgent({name: 'first_agent'})],
    });

    const text = await captureMessageText(
      new AgentTool({agent: sequence}),
      sequence,
      {request: 'hello'},
    );

    expect(text).toBe('hello');
  });
});
