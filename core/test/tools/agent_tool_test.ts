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
  ToolExecutionError,
} from '@google/adk';
import {Content, Type} from '@google/genai';
import {fileURLToPath} from 'node:url';
import {describe, expect, it, vi} from 'vitest';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation((config) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
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
});

/** What the nested `Runner.runAsync` call received. */
interface NestedRun {
  runConfig?: RunConfig;
  text?: string;
}

/**
 * Runs an `AgentTool` and reports what the nested `Runner.runAsync` call
 * received.
 *
 * The stand-in Runner is cast the way every case above casts it: `Runner`
 * declares far more members than a nested run touches, so a structural object
 * is not assignable to it.
 */
async function runNested(
  args: Record<string, unknown>,
  parentRunConfig?: RunConfig,
  agent: LlmAgent = new LlmAgent({
    name: 'sub-agent',
    description: 'a sub agent',
  }),
): Promise<NestedRun> {
  const tool = new AgentTool({agent});
  const session = createSession({
    id: 'parent-session',
    appName: 'sub-agent',
    userId: 'parent-user',
  });
  const toolContext = new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session,
      pluginManager: new PluginManager([]),
      runConfig: parentRunConfig,
    }),
  });

  const nested: NestedRun = {};
  const respond = async function* () {
    yield createEvent({
      author: 'sub-agent',
      content: {role: 'model', parts: [{text: 'done'}]},
    });
  };
  vi.mocked(Runner).mockImplementation(
    (config) =>
      ({
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: (params: {runConfig?: RunConfig; newMessage: Content}) => {
          nested.runConfig = params.runConfig;
          nested.text = params.newMessage.parts?.[0]?.text;
          return respond();
        },
      }) as unknown as Runner,
  );

  await tool.runAsync({args, toolContext});
  return nested;
}

describe('AgentTool nested run config', () => {
  it('forwards the caller run config unchanged when no override applies', async () => {
    const parentRunConfig: RunConfig = {
      maxLlmCalls: 7,
      a2aMetadata: {tier: 'x'},
      streamingMode: StreamingMode.NONE,
    };

    const nested = await runNested({request: 'hi'}, parentRunConfig);

    expect(nested.runConfig).toBe(parentRunConfig);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(nested.runConfig?.a2aMetadata).toEqual({tier: 'x'});
  });

  it('forwards a caller run config that sets no streaming mode', async () => {
    const parentRunConfig: RunConfig = {maxLlmCalls: 7};

    const nested = await runNested({request: 'hi'}, parentRunConfig);

    expect(nested.runConfig).toBe(parentRunConfig);
  });

  it('forwards undefined when the caller set no run config', async () => {
    const nested = await runNested({request: 'hi'});

    expect(nested.runConfig).toBeUndefined();
  });

  it('drops supportCfc without changing the caller run config', async () => {
    const parentRunConfig: RunConfig = {supportCfc: true, maxLlmCalls: 7};

    const nested = await runNested({request: 'hi'}, parentRunConfig);

    expect(nested.runConfig?.supportCfc).toBe(false);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(parentRunConfig.supportCfc).toBe(true);
  });

  it('forces a unary nested run for a streaming caller', async () => {
    const parentRunConfig: RunConfig = {
      streamingMode: StreamingMode.SSE,
      maxLlmCalls: 7,
    };

    const nested = await runNested({request: 'hi'}, parentRunConfig);

    expect(nested.runConfig?.streamingMode).toBe(StreamingMode.NONE);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(parentRunConfig.streamingMode).toBe(StreamingMode.SSE);
  });

  it('applies both overrides at once', async () => {
    const parentRunConfig: RunConfig = {
      streamingMode: StreamingMode.SSE,
      supportCfc: true,
      maxLlmCalls: 7,
    };

    const nested = await runNested({request: 'hi'}, parentRunConfig);

    expect(nested.runConfig?.supportCfc).toBe(false);
    expect(nested.runConfig?.streamingMode).toBe(StreamingMode.NONE);
    expect(nested.runConfig?.maxLlmCalls).toBe(7);
  });
});

describe('AgentTool prompt text without an input schema', () => {
  it('sorts the argument keys, whatever order the model emitted them in', async () => {
    const inserted = await runNested({product: 'shoes', brand: 'Nike'});
    const reversed = await runNested({brand: 'Nike', product: 'shoes'});

    expect(inserted.text).toBe('{"brand":"Nike","product":"shoes"}');
    expect(reversed.text).toBe(inserted.text);
  });

  it('passes a request argument through verbatim', async () => {
    const nested = await runNested({request: 'find me Nike running shoes'});

    expect(nested.text).toBe('find me Nike running shoes');
  });

  it('keeps an empty request argument rather than dumping the arguments', async () => {
    const nested = await runNested({request: ''});

    expect(nested.text).toBe('');
  });
});

describe('AgentTool prompt text with an input schema', () => {
  it('leaves the schema branch serializing the arguments as they arrive', async () => {
    const agent = new LlmAgent({
      name: 'sub-agent',
      description: 'a sub agent',
      inputSchema: {
        type: Type.OBJECT,
        properties: {product: {type: Type.STRING}, brand: {type: Type.STRING}},
      },
    });

    const nested = await runNested(
      {product: 'shoes', brand: 'Nike'},
      undefined,
      agent,
    );

    expect(nested.text).toBe('{"product":"shoes","brand":"Nike"}');
  });
});

describe('AgentTool.fromConfig', () => {
  const FIXTURE_PATH = fileURLToPath(
    new URL('./fixtures/config_agents.ts', import.meta.url),
  );
  const CONFIG_PATH = fileURLToPath(
    new URL('./fixtures/root_agent.yaml', import.meta.url),
  );

  it('wraps the agent the code reference resolves to', async () => {
    const tool = await AgentTool.fromConfig(
      {agent: {code: `${FIXTURE_PATH}#weatherAgent`}},
      CONFIG_PATH,
    );

    expect(tool.name).toBe('weather_agent');
    expect(tool.description).toBe('Answers questions about the weather.');
  });

  it('resolves a relative code reference against the config file', async () => {
    const tool = await AgentTool.fromConfig(
      {
        agent: {code: './fixtures/config_agents.ts#weatherAgent'},
        skipSummarization: true,
      },
      fileURLToPath(new URL('./root_agent.yaml', import.meta.url)),
    );

    expect(tool.name).toBe('weather_agent');
  });

  it('rejects a reference that sets both fields', async () => {
    const building = AgentTool.fromConfig(
      {agent: {code: `${FIXTURE_PATH}#weatherAgent`, configPath: 'a.yaml'}},
      CONFIG_PATH,
    );

    await expect(building).rejects.toThrow(ToolExecutionError);
    await expect(building).rejects.toThrow('exactly one of `code`');
  });

  it('rejects a reference that sets neither field', async () => {
    const building = AgentTool.fromConfig({agent: {}}, CONFIG_PATH);

    await expect(building).rejects.toThrow('exactly one of `code`');
  });

  it('refuses a configPath reference, which adk-js cannot load', async () => {
    const building = AgentTool.fromConfig(
      {agent: {configPath: './weather.yaml'}},
      CONFIG_PATH,
    );

    await expect(building).rejects.toThrow(ToolExecutionError);
    await expect(building).rejects.toThrow('no agent config loader');
  });

  it('rejects a code reference that resolves to something else', async () => {
    const building = AgentTool.fromConfig(
      {agent: {code: `${FIXTURE_PATH}#notAnAgent`}},
      CONFIG_PATH,
    );

    await expect(building).rejects.toThrow('does not resolve to an agent');
  });
});
