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
      runAsync: vi.fn(),
      close: vi.fn(),
    })),
  };
});

/** What `AgentTool` handed the nested run. */
interface NestedRun {
  runConfig?: RunConfig;
  newMessage?: Content;
}

/** The nested run this file's `Runner` stub performs. */
type StubRun = (params: {
  runConfig?: RunConfig;
  newMessage: Content;
}) => AsyncGenerator<Event, void, void>;

/**
 * Installs a `Runner` stub that runs `run` and reports whether it was closed.
 *
 * The one cast is the mock pattern this file already uses: a partial stub
 * cannot satisfy the whole `Runner` shape.
 */
function stubRunner(run: StubRun): Mock {
  const close = vi.fn();
  vi.mocked(Runner).mockImplementation(
    (config) =>
      ({
        appName: config?.appName,
        sessionService: config?.sessionService,
        close,
        runAsync: run,
      }) as unknown as Runner,
  );
  return close;
}

/**
 * Installs a `Runner` stub that records what `AgentTool` hands the nested run,
 * then answers with `replyText`.
 */
function captureNestedRun(replyText = 'done'): {
  nested: NestedRun;
  close: Mock;
} {
  const nested: NestedRun = {};
  const close = stubRunner(async function* (params) {
    nested.runConfig = params.runConfig;
    nested.newMessage = params.newMessage;
    yield createEvent({
      author: 'sub-agent',
      content: {role: 'model', parts: [{text: replyText}]},
    });
  });
  return {nested, close};
}

/** A tool context whose invocation carries `runConfig`. */
function createToolContext(
  agent: LlmAgent,
  runConfig?: RunConfig,
  abortSignal?: AbortSignal,
): Context {
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
      abortSignal,
    }),
  });
}

const SUB_AGENT = new LlmAgent({
  name: 'sub-agent',
  model: 'gemini-2.5-flash',
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

    stubRunner(mockRunAsync);

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

    stubRunner(mockRunAsync);

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

    stubRunner(mockRunAsync);

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

    stubRunner(mockRunAsync);

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

    stubRunner(mockRunAsync);

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

    stubRunner(mockRunAsync);

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

    stubRunner(mockRunAsync);

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

    stubRunner(mockRunAsync);

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

describe('AgentTool nested run config', () => {
  it('forwards the caller run config to the nested run', async () => {
    const {nested} = captureNestedRun();
    const callerConfig: RunConfig = {maxLlmCalls: 7, a2aMetadata: {tier: 'x'}};

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(SUB_AGENT, callerConfig),
    });

    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(nested.runConfig?.a2aMetadata).toEqual({tier: 'x'});
  });

  it('disables supportCfc for the nested run', async () => {
    const {nested} = captureNestedRun();
    const callerConfig: RunConfig = {supportCfc: true, maxLlmCalls: 7};

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(SUB_AGENT, callerConfig),
    });

    expect(nested.runConfig?.supportCfc).toBe(false);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(callerConfig.supportCfc).toBe(true);
  });

  it('forces the nested run unary when the caller streams', async () => {
    const {nested} = captureNestedRun();
    const callerConfig: RunConfig = {
      streamingMode: StreamingMode.SSE,
      maxLlmCalls: 7,
    };

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(SUB_AGENT, callerConfig),
    });

    expect(nested.runConfig?.streamingMode).toBe(StreamingMode.NONE);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(callerConfig.streamingMode).toBe(StreamingMode.SSE);
  });

  it('leaves an already unary caller config as it stands', async () => {
    const {nested} = captureNestedRun();
    const callerConfig: RunConfig = {
      streamingMode: StreamingMode.NONE,
      maxLlmCalls: 7,
    };

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(SUB_AGENT, callerConfig),
    });

    expect(nested.runConfig).toEqual({
      streamingMode: StreamingMode.NONE,
      maxLlmCalls: 7,
      supportCfc: false,
    });
  });

  it('passes no run config when the caller has none', async () => {
    const {nested} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(SUB_AGENT),
    });

    expect(nested.runConfig).toBeUndefined();
  });
});

describe('AgentTool runner lifecycle', () => {
  it('closes the nested runner after a completed run', async () => {
    const {close} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(SUB_AGENT),
    });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the nested runner when the caller aborts before the run', async () => {
    const {close} = captureNestedRun();
    const controller = new AbortController();
    controller.abort();

    const result = await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(SUB_AGENT, undefined, controller.signal),
    });

    expect(result).toBe('');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the nested runner when the caller aborts mid-run', async () => {
    const controller = new AbortController();
    const close = stubRunner(async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'first'}]},
      });
      controller.abort();
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'second'}]},
      });
    });

    const result = await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext(SUB_AGENT, undefined, controller.signal),
    });

    expect(result).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the nested runner when the nested run throws mid-stream', async () => {
    const close = stubRunner(async function* () {
      yield createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'partial'}]},
      });
      throw new Error('sub-agent exploded');
    });

    await expect(
      new AgentTool({agent: SUB_AGENT}).runAsync({
        args: {request: 'hello'},
        toolContext: createToolContext(SUB_AGENT),
      }),
    ).rejects.toThrow('sub-agent exploded');
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('AgentTool argument serialization', () => {
  it('sends named arguments as key-sorted JSON', async () => {
    const {nested} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {product: 'running shoes', brand: 'Nike'},
      toolContext: createToolContext(SUB_AGENT),
    });

    expect(nested.newMessage?.parts?.[0]?.text).toBe(
      '{"brand":"Nike","product":"running shoes"}',
    );
  });

  it('sends a request argument verbatim', async () => {
    const {nested} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'find me Nike running shoes'},
      toolContext: createToolContext(SUB_AGENT),
    });

    expect(nested.newMessage?.parts?.[0]?.text).toBe(
      'find me Nike running shoes',
    );
  });

  it('preserves an empty request argument', async () => {
    const {nested} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: ''},
      toolContext: createToolContext(SUB_AGENT),
    });

    expect(nested.newMessage?.parts?.[0]?.text).toBe('');
  });

  it('sorts a non-string request argument into JSON', async () => {
    const {nested} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: {b: 2, a: 1}},
      toolContext: createToolContext(SUB_AGENT),
    });

    expect(nested.newMessage?.parts?.[0]?.text).toBe(
      '{"request":{"a":1,"b":2}}',
    );
  });
});

describe('AgentTool input schema', () => {
  const inputSchema = z.object({query: z.string(), limit: z.number()});

  function schemaAgent(description = 'searches the catalogue'): LlmAgent {
    return new LlmAgent({
      name: 'sub-agent',
      model: 'gemini-2.5-flash',
      description,
      inputSchema,
    });
  }

  it('sends the validated arguments as a bare JSON document', async () => {
    const {nested} = captureNestedRun();
    const agent = schemaAgent();

    await new AgentTool({agent}).runAsync({
      args: {query: 'hello', limit: 5},
      toolContext: createToolContext(agent),
    });

    const text = nested.newMessage?.parts?.[0]?.text;
    if (text === undefined) {
      expect.fail('the nested run received no text part');
    }
    expect(JSON.parse(text)).toEqual({query: 'hello', limit: 5});
  });

  it('rejects arguments that violate the input schema before the sub-agent starts', async () => {
    captureNestedRun();
    const agent = schemaAgent();
    vi.mocked(Runner).mockClear();

    await expect(
      new AgentTool({agent}).runAsync({
        args: {query: 'hello'},
        toolContext: createToolContext(agent),
      }),
    ).rejects.toThrow();
    expect(vi.mocked(Runner)).not.toHaveBeenCalled();
  });

  it('enforces a refinement the genai schema form cannot express', async () => {
    captureNestedRun();
    const agent = new LlmAgent({
      name: 'sub-agent',
      model: 'gemini-2.5-flash',
      inputSchema: z.object({
        query: z.string().refine((v) => !v.includes(' '), 'no spaces'),
      }),
    });

    await expect(
      new AgentTool({agent}).runAsync({
        args: {query: 'two words'},
        toolContext: createToolContext(agent),
      }),
    ).rejects.toThrow(/no spaces/);
  });

  it('declares the input schema as the tool parameters', () => {
    const agent = schemaAgent();
    const declaration = new AgentTool({agent})._getDeclaration();

    const parameters = declaration.parameters;
    if (parameters === undefined) {
      expect.fail('the declaration carries no parameters');
    }
    expect(parameters.type).toBe(Type.OBJECT);
    expect(Object.keys(parameters.properties ?? {})).toEqual([
      'query',
      'limit',
    ]);
  });

  it('validates against a genai schema set after the agent was built', async () => {
    captureNestedRun();
    const agent = new LlmAgent({name: 'sub-agent', model: 'gemini-2.5-flash'});
    agent.inputSchema = {
      type: Type.OBJECT,
      properties: {query: {type: Type.STRING}},
      required: ['query'],
    };

    await expect(
      new AgentTool({agent}).runAsync({
        args: {limit: 5},
        toolContext: createToolContext(agent),
      }),
    ).rejects.toThrow();
  });

  it('describes the tool with the agent description, not the schema', () => {
    const agent = schemaAgent('answers catalogue questions');
    const declaration = new AgentTool({agent})._getDeclaration();

    expect(declaration.description).toBe('answers catalogue questions');
  });
});
