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
  FeatureName,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Runner,
  State,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';

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

/**
 * The `Runner` mock the tool sees, capturing the config `AgentTool` built it
 * with. The cast is unavoidable: the mock implements the two members
 * `AgentTool.runAsync` touches, and `Runner`'s full surface is far wider.
 */
function mockRunner(
  captured: {appName?: string; sessionService?: InMemorySessionService},
  events: Event[],
): void {
  vi.mocked(Runner).mockImplementation((config) => {
    captured.appName = config?.appName;
    captured.sessionService = config?.sessionService as InMemorySessionService;
    return {
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: async function* () {
        yield* events;
      },
    } as unknown as Runner;
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

    expect(mockSessionService.getOrCreateSession).not.toHaveBeenCalled();

    // Verify state update called with sub-agent's state delta
    expect(toolContext.state.update).toHaveBeenCalledWith({
      someKey: 'someValue',
    });
  });

  it('creates a fresh session per invocation within the same parent session', async () => {
    const mockAgent = {
      name: 'sub-agent',
    } as unknown as LlmAgent;

    const tool = new AgentTool({agent: mockAgent});

    const mockSessionService = new InMemorySessionService();
    vi.spyOn(mockSessionService, 'getOrCreateSession');

    const session = createSession({
      id: 'parent-session',
      appName: 'parent-app',
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

    const childSessionIds: string[] = [];
    vi.mocked(Runner).mockImplementation((config) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: vi.fn((request: {sessionId: string}) => {
          childSessionIds.push(request.sessionId);
          return mockRunAsync();
        }),
      } as unknown as Runner;
    });

    // Invoke twice simulating two turns in the same parent session
    await tool.runAsync({args: {request: 'first'}, toolContext});
    await tool.runAsync({args: {request: 'second'}, toolContext});

    expect(childSessionIds).toHaveLength(2);
    expect(childSessionIds[0]).not.toBe(childSessionIds[1]);
    expect(childSessionIds).not.toContain('parent-session');
    expect(mockSessionService.getOrCreateSession).not.toHaveBeenCalled();

    // Neither child session was written to the caller's session service.
    const parentSessions = await mockSessionService.listSessions({
      appName: 'parent-app',
      userId: 'parent-user',
    });
    expect(parentSessions.sessions).toHaveLength(0);
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

  it('sets skipSummarization on toolContext actions when skipSummarization is true', async () => {
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

    expect(toolContext.actions.skipSummarization).toBe(true);
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

    const session = createSession({
      id: 'parent-session',
      appName: 'parent-app',
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
      sessionService: new InMemorySessionService(),
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

    let childSessionService: InMemorySessionService | undefined;
    vi.mocked(Runner).mockImplementation((config) => {
      childSessionService = config?.sessionService as InMemorySessionService;
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

    const childSessions = await childSessionService!.listSessions({
      appName: 'parent-app',
      userId: 'parent-user',
    });

    expect(childSessions.sessions).toHaveLength(1);
    const subAgentSession = await childSessionService!.getSession({
      appName: 'parent-app',
      userId: 'parent-user',
      sessionId: childSessions.sessions[0].id,
    });

    expect(subAgentSession?.state).toHaveProperty('normalKey', 'parentValue');
    expect(subAgentSession?.state).not.toHaveProperty(
      `${State.TEMP_PREFIX}tempKey`,
    );
  });

  it('files the child runner and session under the parent app name', async () => {
    const subAgent = new LlmAgent({name: 'sub-agent', description: 'a stub'});
    const tool = new AgentTool({agent: subAgent});

    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        agent: subAgent,
        session: createSession({
          id: 'parent-session',
          appName: 'parent-app',
          userId: 'parent-user',
        }),
        pluginManager: new PluginManager([]),
        sessionService: new InMemorySessionService(),
      }),
    });

    const captured: {
      appName?: string;
      sessionService?: InMemorySessionService;
    } = {};
    mockRunner(captured, [
      createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      }),
    ]);

    await tool.runAsync({args: {request: 'hello'}, toolContext});

    expect(captured.appName).toBe('parent-app');
    const childSessions = await captured.sessionService!.listSessions({
      appName: 'parent-app',
      userId: 'parent-user',
    });
    expect(childSessions.sessions).toHaveLength(1);
  });

  it('does not forward _adk-prefixed parent state to the child session', async () => {
    const subAgent = new LlmAgent({name: 'sub-agent', description: 'a stub'});
    const tool = new AgentTool({agent: subAgent});

    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        agent: subAgent,
        session: createSession({
          id: 'parent-session',
          appName: 'parent-app',
          userId: 'parent-user',
          state: {normalKey: 'keepMe', _adkBookkeeping: 'dropMe'},
        }),
        pluginManager: new PluginManager([]),
        sessionService: new InMemorySessionService(),
      }),
    });

    const captured: {
      appName?: string;
      sessionService?: InMemorySessionService;
    } = {};
    mockRunner(captured, [
      createEvent({
        author: 'sub-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      }),
    ]);

    await tool.runAsync({args: {request: 'hello'}, toolContext});

    const childSessions = await captured.sessionService!.listSessions({
      appName: 'parent-app',
      userId: 'parent-user',
    });
    const childSession = await captured.sessionService!.getSession({
      appName: 'parent-app',
      userId: 'parent-user',
      sessionId: childSessions.sessions[0].id,
    });

    expect(childSession?.state).toHaveProperty('normalKey', 'keepMe');
    expect(childSession?.state).not.toHaveProperty('_adkBookkeeping');
  });
});

const REQUEST_JSON_SCHEMA = {
  type: 'object',
  properties: {request: {type: 'string'}},
  required: ['request'],
};

/** Runs `body` with JSON_SCHEMA_FOR_FUNC_DECL enabled. */
function withJsonSchemaDeclaration<T>(body: () => T): Promise<T> {
  return withTemporaryFeatureOverride(
    FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
    true,
    body,
  );
}

describe('AgentTool._getDeclaration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('declares a request parameter when the feature is off', () => {
    const agent = new LlmAgent({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
    });

    expect(new AgentTool({agent})._getDeclaration()).toEqual({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      parameters: {
        type: 'OBJECT',
        properties: {request: {type: 'STRING'}},
        required: ['request'],
      },
    });
  });

  it('declares the agent input schema as parameters when the feature is off', () => {
    const agent = new LlmAgent({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      inputSchema: z.object({customInput: z.string()}),
    });

    const declaration = new AgentTool({agent})._getDeclaration();

    expect(declaration.parameters).toEqual(agent.inputSchema);
    expect(declaration.parametersJsonSchema).toBeUndefined();
  });

  it('declares a request json schema when the feature is on', async () => {
    const agent = new LlmAgent({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
    });

    const declaration = await withJsonSchemaDeclaration(() =>
      new AgentTool({agent})._getDeclaration(),
    );

    expect(declaration).toEqual({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      parametersJsonSchema: REQUEST_JSON_SCHEMA,
    });
    expect(declaration.parameters).toBeUndefined();
  });

  it('declares the agent input schema as a json schema when the feature is on', async () => {
    const agent = new LlmAgent({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      inputSchema: z.object({customInput: z.string()}),
    });

    const declaration = await withJsonSchemaDeclaration(() =>
      new AgentTool({agent})._getDeclaration(),
    );

    expect(declaration.parametersJsonSchema).toMatchObject({
      type: 'object',
      properties: {customInput: {type: 'string'}},
      required: ['customInput'],
    });
    expect(declaration.parameters).toBeUndefined();
  });

  it('declares a string response json schema off GEMINI_API without an output schema', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const agent = new LlmAgent({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
    });

    const declaration = await withJsonSchemaDeclaration(() =>
      new AgentTool({agent})._getDeclaration(),
    );

    expect(declaration).toEqual({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      parametersJsonSchema: REQUEST_JSON_SCHEMA,
      responseJsonSchema: {type: 'string'},
    });
    expect(declaration.response).toBeUndefined();
  });

  it('declares an object response json schema off GEMINI_API with an output schema', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const agent = new LlmAgent({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      outputSchema: z.object({customOutput: z.string()}),
    });

    const declaration = await withJsonSchemaDeclaration(() =>
      new AgentTool({agent})._getDeclaration(),
    );

    expect(declaration.responseJsonSchema).toEqual({type: 'object'});
    expect(declaration.response).toBeUndefined();
  });

  it('declares no response json schema on GEMINI_API', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'false');
    const agent = new LlmAgent({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      outputSchema: z.object({customOutput: z.string()}),
    });

    const declaration = await withJsonSchemaDeclaration(() =>
      new AgentTool({agent})._getDeclaration(),
    );

    expect(declaration).toEqual({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      parametersJsonSchema: REQUEST_JSON_SCHEMA,
    });
  });

  it('declares a genai response schema off GEMINI_API when the feature is off', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const agent = new LlmAgent({
      name: 'tool_agent',
      description: 'A tool agent for testing.',
      outputSchema: z.object({customOutput: z.string()}),
    });

    const declaration = new AgentTool({agent})._getDeclaration();

    expect(declaration.response).toEqual({type: 'OBJECT'});
    expect(declaration.responseJsonSchema).toBeUndefined();
  });
});
