/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseAgent,
  BasePlugin,
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
  RunConfig,
  Runner,
  SequentialAgent,
  State,
  StreamingMode,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Content, GroundingMetadata, Part, Type} from '@google/genai';
import {afterEach, describe, expect, it, Mock, vi} from 'vitest';
import {z} from 'zod';

/** Selects the Vertex AI variant, which is not GEMINI_API. */
const ENTERPRISE_MODE_ENV_VAR = 'GOOGLE_GENAI_USE_ENTERPRISE';

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
      closeToolsets: vi.fn(),
    })),
  };
});

/**
 * The `Runner` mock the tool sees, capturing the config `AgentTool` built it
 * with. The cast is unavoidable: the mock implements the two members
 * `AgentTool.runAsync` touches, and `Runner`'s full surface is far wider.
 */
function mockRunnerCapturingConfig(
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
      closeToolsets: vi.fn(),
    } as unknown as Runner;
  });
}

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
 * Installs a `Runner` stub that runs `run`, and returns the mock recording
 * whether the tool released the nested runner's toolsets.
 *
 * The one cast is the mock pattern this file already uses: a partial stub
 * cannot satisfy the whole `Runner` shape.
 */
function stubRunner(run: StubRun): Mock {
  const closeToolsets = vi.fn();
  vi.mocked(Runner).mockImplementation(
    (config) =>
      ({
        appName: config?.appName,
        sessionService: config?.sessionService,
        closeToolsets,
        runAsync: run,
      }) as unknown as Runner,
  );
  return closeToolsets;
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
        closeToolsets: vi.fn(),
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

    stubRunner(mockRunAsync);

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
        close: vi.fn(),
        runAsync: mockRunAsync,
        closeToolsets: vi.fn(),
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
    mockRunnerCapturingConfig(captured, [
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
    mockRunnerCapturingConfig(captured, [
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

/**
 * A `Runner` stand-in for one test, plus a record of what the sub-runner saw.
 *
 * `mockImplementation` is typed to return a whole `Runner`, and the tool uses
 * three of its members, so the double is cast the way the tests above cast
 * theirs.
 */
function mockRunner(stream: () => AsyncGenerator<Event, void, void>) {
  const seen = {
    plugins: undefined as BasePlugin[] | undefined,
    messageText: undefined as string | undefined,
    runCalls: 0,
    // Set when the generator is closed, by exhaustion or by disposal.
    streamClosed: false,
    // Set only when the caller read every event, so an early disposal is
    // distinguishable from a stream that simply ran out.
    streamExhausted: false,
  };
  vi.mocked(Runner).mockClear();
  vi.mocked(Runner).mockImplementation((config) => {
    seen.plugins = config?.plugins;
    return {
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: async function* (params: {newMessage: Content}) {
        seen.runCalls += 1;
        seen.messageText = params.newMessage.parts?.[0].text;
        try {
          yield* stream();
          seen.streamExhausted = true;
        } finally {
          seen.streamClosed = true;
        }
      },
      closeToolsets: vi.fn(),
    } as unknown as Runner;
  });
  return seen;
}

/** An event stream that replays `events` and then ends. */
function replay(...events: Event[]): () => AsyncGenerator<Event, void, void> {
  return async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

/** A model reply carrying `parts`. */
function reply(parts: Part[], extra: Partial<Event> = {}): Event {
  return createEvent({
    author: 'sub-agent',
    content: {role: 'model', parts},
    ...extra,
  });
}

function createToolContext(options: {
  agent: BaseAgent;
  plugins?: BasePlugin[];
  abortSignal?: AbortSignal;
  runConfig?: RunConfig;
}): Context {
  const session = createSession({
    id: 'parent-session',
    appName: options.agent.name,
    userId: 'parent-user',
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: options.agent,
      session,
      pluginManager: new PluginManager(options.plugins ?? []),
      sessionService: new InMemorySessionService(),
      runConfig: options.runConfig,
      abortSignal: options.abortSignal,
    }),
  });
}

/** An agent that answers with `text`, with no schemas of its own. */
function createSubAgent(name = 'sub-agent'): LlmAgent {
  return new LlmAgent({name, description: `${name} description`});
}

describe('AgentTool schema resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes the first sub-agent input schema of a composite agent', () => {
    const first = new LlmAgent({
      name: 'first',
      description: 'first',
      inputSchema: z.object({query: z.string()}),
    });
    const pipeline = new SequentialAgent({
      name: 'pipeline',
      description: 'research then summarise',
      subAgents: [first, createSubAgent('second')],
    });

    const declaration = new AgentTool({agent: pipeline})._getDeclaration();

    expect(declaration.parameters).toEqual(first.inputSchema);
  });

  it('falls back to the request parameter when no sub-agent declares an input schema', () => {
    const pipeline = new SequentialAgent({
      name: 'pipeline',
      description: 'research then summarise',
      subAgents: [createSubAgent('first'), createSubAgent('second')],
    });

    const declaration = new AgentTool({agent: pipeline})._getDeclaration();

    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {'request': {type: Type.STRING}},
      required: ['request'],
    });
  });

  it('reads the output schema off the last sub-agent, not the first', () => {
    // `response` is only set on non-GEMINI_API variants.
    vi.stubEnv(ENTERPRISE_MODE_ENV_VAR, 'true');
    const structuredAgent = () =>
      new LlmAgent({
        name: 'structured',
        description: 'structured',
        outputSchema: z.object({result: z.string()}),
      });

    const lastHasSchema = new AgentTool({
      agent: new SequentialAgent({
        name: 'pipeline',
        description: 'pipeline',
        subAgents: [createSubAgent('first'), structuredAgent()],
      }),
    })._getDeclaration();
    const firstHasSchema = new AgentTool({
      agent: new SequentialAgent({
        name: 'pipeline',
        description: 'pipeline',
        subAgents: [structuredAgent(), createSubAgent('last')],
      }),
    })._getDeclaration();

    expect(lastHasSchema.response).toEqual({type: Type.OBJECT});
    expect(firstHasSchema.response).toEqual({type: Type.STRING});
  });

  it('finds the input schema of a nested composite agent', () => {
    const innermost = new LlmAgent({
      name: 'innermost',
      description: 'innermost',
      inputSchema: z.object({query: z.string()}),
    });
    const outer = new SequentialAgent({
      name: 'outer',
      description: 'outer',
      subAgents: [
        new SequentialAgent({
          name: 'inner',
          description: 'inner',
          subAgents: [innermost, createSubAgent('sibling')],
        }),
      ],
    });

    const declaration = new AgentTool({agent: outer})._getDeclaration();

    expect(declaration.parameters).toEqual(innermost.inputSchema);
  });

  it('falls back to the request parameter for a composite agent with no sub-agents', () => {
    const empty = new SequentialAgent({
      name: 'empty',
      description: 'empty',
      subAgents: [],
    });

    const declaration = new AgentTool({agent: empty})._getDeclaration();

    expect(declaration.parameters?.properties).toHaveProperty('request');
  });

  it('validates against the first sub-agent input schema and the last sub-agent output schema', async () => {
    const first = new LlmAgent({
      name: 'first',
      description: 'first',
      inputSchema: z.object({query: z.string()}),
    });
    const last = new LlmAgent({
      name: 'last',
      description: 'last',
      outputSchema: z.object({result: z.string()}),
    });
    const pipeline = new SequentialAgent({
      name: 'pipeline',
      description: 'pipeline',
      subAgents: [first, last],
    });
    const seen = mockRunner(replay(reply([{text: '{"result": "done"}'}])));

    const result = await new AgentTool({agent: pipeline}).runAsync({
      args: {query: 'shoes'},
      toolContext: createToolContext({agent: pipeline}),
    });

    expect(seen.messageText).toBe('{"query":"shoes"}');
    expect(result).toEqual({result: 'done'});
  });
});

describe('AgentTool input validation', () => {
  it('sends the validated payload as a bare JSON document', async () => {
    const agent = new LlmAgent({
      name: 'sub-agent',
      description: 'sub-agent',
      inputSchema: z.object({query: z.string(), limit: z.number()}),
    });
    const seen = mockRunner(replay(reply([{text: 'ok'}])));

    await new AgentTool({agent}).runAsync({
      args: {query: 'shoes', limit: 5},
      toolContext: createToolContext({agent}),
    });

    expect(seen.messageText).toBeDefined();
    expect(JSON.parse(seen.messageText!)).toEqual({query: 'shoes', limit: 5});
  });

  it('rejects arguments that violate the input schema before starting the sub-agent', async () => {
    const agent = new LlmAgent({
      name: 'sub-agent',
      description: 'sub-agent',
      inputSchema: z.object({query: z.string(), limit: z.number()}),
    });
    const seen = mockRunner(replay(reply([{text: 'ok'}])));

    await expect(
      new AgentTool({agent}).runAsync({
        args: {query: 'shoes'},
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow();

    expect(seen.runCalls).toBe(0);
    expect(vi.mocked(Runner)).not.toHaveBeenCalled();
  });

  it('enforces a Zod constraint the genai schema form cannot express', async () => {
    const agent = new LlmAgent({
      name: 'sub-agent',
      description: 'sub-agent',
      inputSchema: z.object({
        query: z.string().refine((value) => !value.includes(' '), 'no spaces'),
      }),
    });
    mockRunner(replay(reply([{text: 'ok'}])));

    // The genai form keeps only `{type: STRING}`, so this rejects only if the
    // schema as supplied is the one enforced.
    expect(agent.inputSchema?.properties?.['query']).toEqual({type: 'STRING'});
    await expect(
      new AgentTool({agent}).runAsync({
        args: {query: 'two words'},
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow(/no spaces/);
  });
});

describe('AgentTool output validation', () => {
  const structuredAgent = () =>
    new LlmAgent({
      name: 'sub-agent',
      description: 'sub-agent',
      outputSchema: z.object({result: z.string()}),
    });

  it('returns the parsed object for a reply that satisfies the output schema', async () => {
    const agent = structuredAgent();
    mockRunner(replay(reply([{text: '{"result": "done"}'}])));

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(result).toEqual({result: 'done'});
  });

  it('rejects a reply that violates the output schema', async () => {
    const agent = structuredAgent();
    mockRunner(replay(reply([{text: '{"result": 42}'}])));

    await expect(
      new AgentTool({agent}).runAsync({
        args: {request: 'go'},
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow();
  });

  it('rejects a reply that is not JSON at all', async () => {
    const agent = structuredAgent();
    mockRunner(replay(reply([{text: 'sorry, I could not do that'}])));

    await expect(
      new AgentTool({agent}).runAsync({
        args: {request: 'go'},
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow();
  });

  it('strips a markdown code fence around the reply', async () => {
    const agent = structuredAgent();
    mockRunner(replay(reply([{text: '```json\n{"result": "done"}\n```'}])));

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(result).toEqual({result: 'done'});
  });

  it('rejects an unterminated fence padded with whitespace without stalling', async () => {
    const agent = structuredAgent();
    // An opening fence the model never closed, a long run of blank lines, and
    // a payload after them. A backtracking fence pattern spends seconds on
    // this and blocks the whole process, so the call must finish inside the
    // test timeout.
    const unclosedFence = `\`\`\`json\n${'\n'.repeat(4000)}{"result": "done"}`;
    mockRunner(replay(reply([{text: unclosedFence}])));

    await expect(
      new AgentTool({agent}).runAsync({
        args: {request: 'go'},
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow();
  });

  it('returns the merged text unparsed when the agent declares no output schema', async () => {
    const agent = createSubAgent();
    mockRunner(replay(reply([{text: '{"result": "done"}'}])));

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(result).toBe('{"result": "done"}');
  });
});

describe('AgentTool plugin propagation', () => {
  class RecordingPlugin extends BasePlugin {
    calls = 0;

    override async beforeRunCallback(): Promise<undefined> {
      this.calls += 1;
      return undefined;
    }
  }

  it('lends the parent plugins to the sub-runner by default', async () => {
    const agent = createSubAgent();
    const plugin = new RecordingPlugin('recorder');
    const seen = mockRunner(replay(reply([{text: 'done'}])));

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent, plugins: [plugin]}),
    });

    expect(seen.plugins).toEqual([plugin]);
  });

  it('passes no plugins when includePlugins is false', async () => {
    const agent = createSubAgent();
    const plugin = new RecordingPlugin('recorder');
    const seen = mockRunner(replay(reply([{text: 'done'}])));

    await new AgentTool({agent, includePlugins: false}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent, plugins: [plugin]}),
    });

    expect(seen.plugins).toBeUndefined();
  });

  it('passes an empty plugin list when the parent has none', async () => {
    const agent = createSubAgent();
    const seen = mockRunner(replay(reply([{text: 'done'}])));

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(seen.plugins).toEqual([]);
  });

  it('leaves the parent plugins registered and callable after the sub-run', async () => {
    const agent = createSubAgent();
    const plugin = new RecordingPlugin('recorder');
    const toolContext = createToolContext({agent, plugins: [plugin]});
    mockRunner(replay(reply([{text: 'done'}])));

    await new AgentTool({agent}).runAsync({args: {request: 'go'}, toolContext});

    const manager = toolContext.invocationContext.pluginManager;
    expect(manager.getPlugin('recorder')).toBe(plugin);
    await manager.runBeforeRunCallback({
      invocationContext: toolContext.invocationContext,
    });
    expect(plugin.calls).toBe(1);
  });
});

describe('AgentTool grounding metadata', () => {
  const groundingMetadata: GroundingMetadata = {
    webSearchQueries: ['running shoes'],
  };
  const groundingKey = `${State.TEMP_PREFIX}_adk_grounding_metadata`;

  it('publishes the grounding metadata when propagation is on', async () => {
    const agent = createSubAgent();
    const toolContext = createToolContext({agent});
    mockRunner(replay(reply([{text: 'done'}], {groundingMetadata})));

    await new AgentTool({agent, propagateGroundingMetadata: true}).runAsync({
      args: {request: 'go'},
      toolContext,
    });

    expect(toolContext.state.get(groundingKey)).toEqual(groundingMetadata);
  });

  it('does not publish the grounding metadata by default', async () => {
    const agent = createSubAgent();
    const toolContext = createToolContext({agent});
    mockRunner(replay(reply([{text: 'done'}], {groundingMetadata})));

    await new AgentTool({agent}).runAsync({args: {request: 'go'}, toolContext});

    expect(toolContext.state.has(groundingKey)).toBe(false);
  });

  it('leaves the key absent when no event carries grounding metadata', async () => {
    const agent = createSubAgent();
    const toolContext = createToolContext({agent});
    mockRunner(replay(reply([{text: 'done'}])));

    await new AgentTool({agent, propagateGroundingMetadata: true}).runAsync({
      args: {request: 'go'},
      toolContext,
    });

    expect(toolContext.state.has(groundingKey)).toBe(false);
  });

  it('takes the grounding metadata from the last event that carried content', async () => {
    const agent = createSubAgent();
    const toolContext = createToolContext({agent});
    mockRunner(
      replay(
        reply([{text: 'first'}], {groundingMetadata}),
        createEvent({author: 'sub-agent', errorMessage: 'late failure'}),
      ),
    );

    await new AgentTool({agent, propagateGroundingMetadata: true}).runAsync({
      args: {request: 'go'},
      toolContext,
    });

    expect(toolContext.state.get(groundingKey)).toEqual(groundingMetadata);
  });
});

describe('AgentTool error message tracking', () => {
  it('returns the error message of an event that carried no content', async () => {
    const agent = createSubAgent();
    mockRunner(
      replay(
        createEvent({
          author: 'sub-agent',
          errorMessage: 'A2A request failed: 503',
        }),
      ),
    );

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(result).toBe('A2A request failed: 503');
  });

  it('returns the error message when the only content is a thought', async () => {
    const agent = createSubAgent();
    mockRunner(
      replay(
        reply([{text: 'thinking about it', thought: true}]),
        createEvent({author: 'sub-agent', errorMessage: 'model overloaded'}),
      ),
    );

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(result).toBe('model overloaded');
  });

  it('keeps the content when an error event arrives after it', async () => {
    const agent = createSubAgent();
    mockRunner(
      replay(
        reply([{text: 'the real answer'}]),
        createEvent({author: 'sub-agent', errorMessage: 'late failure'}),
      ),
    );

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(result).toBe('the real answer');
  });

  it('returns an empty string when the sub-agent emits no events', async () => {
    const agent = createSubAgent();
    mockRunner(replay());

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(result).toBe('');
  });

  it('returns an empty string for content without parts', async () => {
    const agent = createSubAgent();
    mockRunner(
      replay(createEvent({author: 'sub-agent', content: {role: 'model'}})),
    );

    const result = await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(result).toBe('');
  });
});

describe('AgentTool sub-run teardown', () => {
  it('drives the nested run to completion', async () => {
    const agent = createSubAgent();
    const seen = mockRunner(replay(reply([{text: 'done'}])));

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });

    expect(seen.streamExhausted).toBe(true);
    expect(seen.streamClosed).toBe(true);
  });

  it('disposes the nested run when the caller aborts mid-stream', async () => {
    const agent = createSubAgent();
    const controller = new AbortController();
    const seen = mockRunner(async function* () {
      yield reply([{text: 'first'}]);
      controller.abort();
      yield reply([{text: 'second'}]);
    });

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({
        agent,
        abortSignal: controller.signal,
      }),
    });

    // Closed without being read to the end: the tool disposed it early.
    expect(seen.streamExhausted).toBe(false);
    expect(seen.streamClosed).toBe(true);
  });

  it('disposes the nested run when output validation rejects', async () => {
    const agent = new LlmAgent({
      name: 'sub-agent',
      description: 'sub-agent',
      outputSchema: z.object({result: z.string()}),
    });
    const seen = mockRunner(replay(reply([{text: 'not json'}])));

    await expect(
      new AgentTool({agent}).runAsync({
        args: {request: 'go'},
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow();

    expect(seen.streamExhausted).toBe(true);
    expect(seen.streamClosed).toBe(true);
  });
});

describe('AgentTool part text extraction', () => {
  async function runWithParts(parts: Part[]): Promise<unknown> {
    const agent = createSubAgent();
    mockRunner(replay(reply(parts)));
    return new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: createToolContext({agent}),
    });
  }

  it('returns the text of a text part', async () => {
    expect(await runWithParts([{text: 'plain answer'}])).toBe('plain answer');
  });

  it('strips the trailing newline of a code execution result', async () => {
    const result = await runWithParts([
      {executableCode: {code: 'print(2 ** 10)'}},
      {codeExecutionResult: {output: '1024\n'}},
    ]);

    expect(result).toBe('print(2 ** 10)\n1024');
  });

  it('joins text, executable code and result in order', async () => {
    const result = await runWithParts([
      {text: 'let me compute that'},
      {executableCode: {code: 'print(2 ** 10)'}},
      {codeExecutionResult: {output: '1024\n'}},
    ]);

    expect(result).toBe('let me compute that\nprint(2 ** 10)\n1024');
  });

  it('returns the code of an executable code part on its own', async () => {
    expect(await runWithParts([{executableCode: {code: 'print(1)'}}])).toBe(
      'print(1)',
    );
  });

  it('skips a thought part next to a code execution result', async () => {
    const result = await runWithParts([
      {text: 'thinking', thought: true},
      {codeExecutionResult: {output: '1024\n'}},
    ]);

    expect(result).toBe('1024');
  });

  it('drops a part that carries no text, code or result', async () => {
    const result = await runWithParts([
      {text: 'answer'},
      {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
      {text: 'continued'},
    ]);

    expect(result).toBe('answer\ncontinued');
  });
});

describe('AgentTool argument fallback', () => {
  async function messageTextFor(args: Record<string, unknown>) {
    const agent = createSubAgent();
    const seen = mockRunner(replay(reply([{text: 'done'}])));
    await new AgentTool({agent}).runAsync({
      args,
      toolContext: createToolContext({agent}),
    });
    return seen.messageText;
  }

  it('serializes the whole argument object when there is no request key', async () => {
    const text = await messageTextFor({
      brand: 'Nike',
      product: 'running shoes',
    });

    expect(JSON.parse(text!)).toEqual({
      brand: 'Nike',
      product: 'running shoes',
    });
  });

  it('passes a request string through verbatim', async () => {
    expect(await messageTextFor({request: 'find me Nike running shoes'})).toBe(
      'find me Nike running shoes',
    );
  });

  it('preserves an empty request string', async () => {
    expect(await messageTextFor({request: ''})).toBe('');
  });

  it('serializes an empty argument object', async () => {
    expect(await messageTextFor({})).toBe('{}');
  });

  it('serializes the whole object when request is not a string', async () => {
    expect(await messageTextFor({request: 42})).toBe('{"request":42}');
  });
});

describe('AgentTool nested run config', () => {
  it('forwards the caller run config to the nested run', async () => {
    const {nested} = captureNestedRun();
    const callerConfig: RunConfig = {maxLlmCalls: 7, a2aMetadata: {tier: 'x'}};

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext({
        agent: SUB_AGENT,
        runConfig: callerConfig,
      }),
    });

    expect(nested.runConfig?.maxLlmCalls).toBe(7);
    expect(nested.runConfig?.a2aMetadata).toEqual({tier: 'x'});
  });

  it('disables supportCfc for the nested run', async () => {
    const {nested} = captureNestedRun();
    const callerConfig: RunConfig = {supportCfc: true, maxLlmCalls: 7};

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext({
        agent: SUB_AGENT,
        runConfig: callerConfig,
      }),
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
      toolContext: createToolContext({
        agent: SUB_AGENT,
        runConfig: callerConfig,
      }),
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
      toolContext: createToolContext({
        agent: SUB_AGENT,
        runConfig: callerConfig,
      }),
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
      toolContext: createToolContext({agent: SUB_AGENT}),
    });

    expect(nested.runConfig).toBeUndefined();
  });
});

describe('AgentTool runner lifecycle', () => {
  it('closes the nested runner after a completed run', async () => {
    const {close} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext({agent: SUB_AGENT}),
    });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the nested runner when the caller aborts before the run', async () => {
    const {close} = captureNestedRun();
    const controller = new AbortController();
    controller.abort();

    const result = await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'hello'},
      toolContext: createToolContext({
        agent: SUB_AGENT,
        abortSignal: controller.signal,
      }),
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
      toolContext: createToolContext({
        agent: SUB_AGENT,
        abortSignal: controller.signal,
      }),
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
        toolContext: createToolContext({agent: SUB_AGENT}),
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
      toolContext: createToolContext({agent: SUB_AGENT}),
    });

    expect(nested.newMessage?.parts?.[0]?.text).toBe(
      '{"brand":"Nike","product":"running shoes"}',
    );
  });

  it('sends a request argument verbatim', async () => {
    const {nested} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: 'find me Nike running shoes'},
      toolContext: createToolContext({agent: SUB_AGENT}),
    });

    expect(nested.newMessage?.parts?.[0]?.text).toBe(
      'find me Nike running shoes',
    );
  });

  it('preserves an empty request argument', async () => {
    const {nested} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: ''},
      toolContext: createToolContext({agent: SUB_AGENT}),
    });

    expect(nested.newMessage?.parts?.[0]?.text).toBe('');
  });

  it('sorts a non-string request argument into JSON', async () => {
    const {nested} = captureNestedRun();

    await new AgentTool({agent: SUB_AGENT}).runAsync({
      args: {request: {b: 2, a: 1}},
      toolContext: createToolContext({agent: SUB_AGENT}),
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
      toolContext: createToolContext({agent}),
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
        toolContext: createToolContext({agent}),
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
        toolContext: createToolContext({agent}),
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
        toolContext: createToolContext({agent}),
      }),
    ).rejects.toThrow();
  });

  it('describes the tool with the agent description, not the schema', () => {
    const agent = schemaAgent('answers catalogue questions');
    const declaration = new AgentTool({agent})._getDeclaration();

    expect(declaration.description).toBe('answers catalogue questions');
  });

  it('drops an argument the input schema does not declare', async () => {
    const {nested} = captureNestedRun();
    const agent = schemaAgent();

    await new AgentTool({agent}).runAsync({
      args: {query: 'hello', limit: 5, unexpected: 'dropped'},
      toolContext: createToolContext({agent}),
    });

    const text = nested.newMessage?.parts?.[0]?.text;
    if (text === undefined) {
      expect.fail('the nested run received no text part');
    }
    expect(JSON.parse(text)).toEqual({query: 'hello', limit: 5});
  });

  it('sends the arguments a genai schema accepts', async () => {
    const {nested} = captureNestedRun();
    const agent = new LlmAgent({name: 'sub-agent', model: 'gemini-2.5-flash'});
    agent.inputSchema = {
      type: Type.OBJECT,
      properties: {query: {type: Type.STRING}},
      required: ['query'],
    };

    await new AgentTool({agent}).runAsync({
      args: {query: 'hello'},
      toolContext: createToolContext({agent}),
    });

    expect(nested.newMessage?.parts?.[0]?.text).toBe('{"query":"hello"}');
  });
});
