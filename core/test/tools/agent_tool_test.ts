/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseAgent,
  Context,
  createEvent,
  createEventActions,
  createSession,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Runner,
  SequentialAgent,
  State,
} from '@google/adk';
import {Content, Part, Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
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

describe('AgentTool parity with adk-python', () => {
  const SUB_AGENT_NAME = 'sub-agent';
  const PARENT_APP_NAME = 'parent-app';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Points the mocked `Runner` at `events` and records what the `AgentTool`
   * handed it.
   */
  function mockSubAgentRun(events: Event[]) {
    const received: {messageText?: string; appName?: string} = {};
    const runAsync = vi.fn(async function* (request: {newMessage: Content}) {
      received.messageText = request.newMessage.parts?.[0]?.text;
      yield* events;
    });

    vi.mocked(Runner).mockImplementation((config) => {
      received.appName = config?.appName;
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync,
      } as unknown as Runner;
    });

    return {received, runAsync};
  }

  /** Builds a parent tool context whose session belongs to `appName`. */
  function parentContext(
    agent: BaseAgent,
    appName = PARENT_APP_NAME,
    state: Record<string, unknown> = {},
    sessionService = new InMemorySessionService(),
  ): Context {
    return new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        agent,
        session: createSession({
          id: 'parent-session',
          appName,
          userId: 'parent-user',
          state,
        }),
        pluginManager: new PluginManager([]),
        sessionService,
      }),
    });
  }

  /** Returns the tool result for a sub-agent that emits `parts`. */
  async function resultForParts(parts: Part[]): Promise<unknown> {
    const agent = new LlmAgent({name: SUB_AGENT_NAME});
    mockSubAgentRun([
      createEvent({author: SUB_AGENT_NAME, content: {role: 'model', parts}}),
    ]);

    return new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: parentContext(agent),
    });
  }

  it("declares an object response from the last sub-agent's output schema", () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const sequence = new SequentialAgent({
      name: 'sequence',
      description: 'Draft then format',
      subAgents: [
        new LlmAgent({name: 'drafter'}),
        new LlmAgent({
          name: 'formatter',
          outputSchema: {
            type: Type.OBJECT,
            properties: {summary: {type: Type.STRING}},
            required: ['summary'],
          },
        }),
      ],
    });

    const declaration = new AgentTool({agent: sequence})._getDeclaration();

    expect(declaration.response).toEqual({type: Type.OBJECT});
  });

  it('declares a string response when only the first sub-agent has an output schema', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const sequence = new SequentialAgent({
      name: 'sequence',
      description: 'Draft then format',
      subAgents: [
        new LlmAgent({
          name: 'drafter',
          outputSchema: {
            type: Type.OBJECT,
            properties: {draft: {type: Type.STRING}},
            required: ['draft'],
          },
        }),
        new LlmAgent({name: 'formatter'}),
      ],
    });

    const declaration = new AgentTool({agent: sequence})._getDeclaration();

    expect(declaration.response).toEqual({type: Type.STRING});
  });

  it('rejects args that violate the input schema before the sub-agent runs', async () => {
    const agent = new LlmAgent({
      name: SUB_AGENT_NAME,
      inputSchema: z.object({query: z.string()}),
    });
    const {runAsync} = mockSubAgentRun([]);

    await expect(
      new AgentTool({agent}).runAsync({
        args: {query: 42},
        toolContext: parentContext(agent),
      }),
    ).rejects.toThrow();
    expect(runAsync).not.toHaveBeenCalled();
  });

  it('sends the validated args as a bare JSON document without null properties', async () => {
    const agent = new LlmAgent({
      name: SUB_AGENT_NAME,
      inputSchema: z.object({
        query: z.string(),
        language: z.string().nullable(),
      }),
    });
    const {received} = mockSubAgentRun([
      createEvent({
        author: SUB_AGENT_NAME,
        content: {role: 'model', parts: [{text: 'done'}]},
      }),
    ]);

    await new AgentTool({agent}).runAsync({
      args: {query: 'hi', language: null},
      toolContext: parentContext(agent),
    });

    expect(received.messageText).toBe('{"query":"hi"}');
  });

  it.each([
    {
      name: 'sorts the keys of args that carry no request',
      args: {product: 'running shoes', brand: 'Nike'},
      expected: '{"brand":"Nike","product":"running shoes"}',
    },
    {
      name: 'passes a request string through unchanged',
      args: {request: 'find me Nike running shoes'},
      expected: 'find me Nike running shoes',
    },
    {
      name: 'keeps an empty request as an empty string',
      args: {request: ''},
      expected: '',
    },
  ])('$name', async ({args, expected}) => {
    const agent = new LlmAgent({name: SUB_AGENT_NAME});
    const {received} = mockSubAgentRun([
      createEvent({
        author: SUB_AGENT_NAME,
        content: {role: 'model', parts: [{text: 'done'}]},
      }),
    ]);

    await new AgentTool({agent}).runAsync({
      args,
      toolContext: parentContext(agent),
    });

    expect(received.messageText).toBe(expected);
  });

  it('returns the code of an executableCode part', async () => {
    const result = await resultForParts([
      {executableCode: {code: 'print("hi")'}},
    ]);

    expect(result).toBe('print("hi")');
  });

  it('returns a code execution result without its trailing newlines', async () => {
    const result = await resultForParts([
      {codeExecutionResult: {output: 'hi\n\n'}},
    ]);

    expect(result).toBe('hi');
  });

  it('joins text, code and execution output in part order', async () => {
    const result = await resultForParts([
      {text: 'Let me compute that.'},
      {executableCode: {code: 'print(6 * 7)'}},
      {codeExecutionResult: {output: '42\n'}},
    ]);

    expect(result).toBe('Let me compute that.\nprint(6 * 7)\n42');
  });

  it('drops a thought part that sits beside a code execution result', async () => {
    const result = await resultForParts([
      {text: 'the user wants arithmetic', thought: true},
      {codeExecutionResult: {output: '42'}},
    ]);

    expect(result).toBe('42');
  });

  it("runs the sub-agent under the parent's app name", async () => {
    const agent = new LlmAgent({name: SUB_AGENT_NAME});
    const sessionService = new InMemorySessionService();
    vi.spyOn(sessionService, 'getOrCreateSession');
    const {received} = mockSubAgentRun([
      createEvent({
        author: SUB_AGENT_NAME,
        content: {role: 'model', parts: [{text: 'done'}]},
      }),
    ]);

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: parentContext(agent, PARENT_APP_NAME, {}, sessionService),
    });

    expect(received.appName).toBe(PARENT_APP_NAME);
    expect(sessionService.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({appName: PARENT_APP_NAME}),
    );
  });

  it('falls back to the agent name when the parent names no app', async () => {
    const agent = new LlmAgent({name: SUB_AGENT_NAME});
    const {received} = mockSubAgentRun([
      createEvent({
        author: SUB_AGENT_NAME,
        content: {role: 'model', parts: [{text: 'done'}]},
      }),
    ]);

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: parentContext(agent, ''),
    });

    expect(received.appName).toBe(SUB_AGENT_NAME);
  });

  it('does not seed _adk-prefixed parent state into the sub-agent session', async () => {
    const agent = new LlmAgent({name: SUB_AGENT_NAME});
    const sessionService = new InMemorySessionService();
    mockSubAgentRun([
      createEvent({
        author: SUB_AGENT_NAME,
        content: {role: 'model', parts: [{text: 'done'}]},
      }),
    ]);

    await new AgentTool({agent}).runAsync({
      args: {request: 'go'},
      toolContext: parentContext(
        agent,
        PARENT_APP_NAME,
        {_adk_internal: 'dropMe', visibleKey: 'keepMe'},
        sessionService,
      ),
    });

    const childSession = await sessionService.getSession({
      appName: PARENT_APP_NAME,
      userId: 'parent-user',
      sessionId: 'parent-session',
    });

    expect(childSession?.state).toHaveProperty('visibleKey', 'keepMe');
    expect(childSession?.state).not.toHaveProperty('_adk_internal');
  });
});
