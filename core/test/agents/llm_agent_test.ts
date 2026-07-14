/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  AuthConfig,
  BaseLlm,
  BaseLlmConnection,
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
  BasePlugin,
  BaseTool,
  CONTENT_REQUEST_PROCESSOR,
  Context,
  ContextCompactorRequestProcessor,
  createEvent,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  REQUEST_EUC_FUNCTION_CALL_NAME,
  RunAsyncToolRequest,
  Session,
  ToolProcessLlmRequest,
} from '@google/adk';
import {Content, Schema, Type} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

class MockLlmConnection implements BaseLlmConnection {
  sendHistory(_history: Content[]): Promise<void> {
    return Promise.resolve();
  }
  sendContent(_content: Content): Promise<void> {
    return Promise.resolve();
  }
  sendRealtime(_blob: {data: string; mimeType: string}): Promise<void> {
    return Promise.resolve();
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    // No-op for mock.
  }
  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class MockLlm extends BaseLlm {
  response: LlmResponse | null;
  error: Error | null;

  constructor(response: LlmResponse | null, error: Error | null = null) {
    super({model: 'mock-llm'});
    this.response = response;
    this.error = error;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    if (this.error) {
      throw this.error;
    }
    if (this.response) {
      yield this.response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

class StreamingMockLlm extends BaseLlm {
  responseChunks: LlmResponse[];

  constructor(chunks: LlmResponse[]) {
    super({model: 'streaming-mock-llm'});
    this.responseChunks = chunks;
  }

  async *generateContentAsync(
    _request: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void, void> {
    for (const chunk of this.responseChunks) {
      if (abortSignal?.aborted) {
        return;
      }
      yield chunk;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

class MockPlugin extends BasePlugin {
  beforeModelResponse?: LlmResponse;
  afterModelResponse?: LlmResponse;
  onModelErrorResponse?: LlmResponse;

  override async beforeModelCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return this.beforeModelResponse;
  }

  override async afterModelCallback(_params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return this.afterModelResponse;
  }

  override async onModelErrorCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return this.onModelErrorResponse;
  }
}

class MockRequestProcessor extends BaseLlmRequestProcessor {
  async *runAsync(
    _invocationContext: InvocationContext,
    _llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({id: 'evt_processor_1', author: 'processor'});
    yield createEvent({id: 'evt_processor_2', author: 'processor'});
  }
}

class MockTool extends BaseTool {
  constructor(
    name: string,
    private controller?: AbortController,
  ) {
    super({name, description: 'mock tool'});
  }
  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    return Promise.resolve({});
  }
  override async processLlmRequest(
    _params: ToolProcessLlmRequest,
  ): Promise<void> {
    if (this.controller) {
      this.controller.abort();
    }
  }
}

class MockToolWithRun extends BaseTool {
  constructor(
    name: string,
    private controller?: AbortController,
  ) {
    super({name, description: 'mock tool with run'});
  }
  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    if (this.controller) {
      this.controller.abort();
    }
    return Promise.resolve({result: 'success'});
  }
  override async processLlmRequest(
    params: ToolProcessLlmRequest,
  ): Promise<void> {
    params.llmRequest.toolsDict[this.name] = this;
  }
}

class MockResponseProcessor extends BaseLlmResponseProcessor {
  async *runAsync(
    _invocationContext: InvocationContext,
    _llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({id: 'evt_response_processor_1', author: 'processor'});
    yield createEvent({id: 'evt_response_processor_2', author: 'processor'});
  }
}

/**
 * A test subclass of LlmAgent to expose protected methods for testing.
 */
class TestLlmAgent extends LlmAgent {
  /** Publicly expose callLlmAsync for testing. */
  async *testCallLlmAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    modelResponseEvent: Event,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield* this.callLlmAsync(invocationContext, llmRequest, modelResponseEvent);
  }

  /** Publicly expose runAndHandleError for testing. */
  async *testRunAndHandleError<T extends LlmResponse | Event>(
    responseGenerator: AsyncGenerator<T, void, void>,
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
    modelResponseEvent: Event,
  ): AsyncGenerator<T, void, void> {
    yield* this.runAndHandleError(
      responseGenerator,
      invocationContext,
      llmRequest,
      modelResponseEvent,
    );
  }
}

describe('LlmAgent.callLlm', () => {
  let agent: TestLlmAgent;
  let invocationContext: InvocationContext;
  let llmRequest: LlmRequest;
  let modelResponseEvent: Event;
  let pluginManager: PluginManager;
  let mockPlugin: MockPlugin;

  const originalLlmResponse: LlmResponse = {
    content: {parts: [{text: 'original'}]},
  };
  const beforePluginResponse: LlmResponse = {
    content: {parts: [{text: 'before plugin'}]},
  };
  const beforeCallbackResponse: LlmResponse = {
    content: {parts: [{text: 'before callback'}]},
  };
  const afterPluginResponse: LlmResponse = {
    content: {parts: [{text: 'after plugin'}]},
  };
  const afterCallbackResponse: LlmResponse = {
    content: {parts: [{text: 'after callback'}]},
  };
  const onModelErrorPluginResponse: LlmResponse = {
    content: {parts: [{text: 'on model error plugin'}]},
  };
  const modelError = new Error(
    JSON.stringify({
      error: {
        message: 'LLM error',
        code: 500,
      },
    }),
  );

  beforeEach(() => {
    mockPlugin = new MockPlugin('mock_plugin');
    pluginManager = new PluginManager();
    agent = new TestLlmAgent({name: 'test_agent'});
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent: agent,
      pluginManager,
    });
    llmRequest = {contents: [], liveConnectConfig: {}, toolsDict: {}};
    modelResponseEvent = {id: 'evt_123'} as Event;
  });

  async function callLlmUnderTest(): Promise<LlmResponse[]> {
    const responses: LlmResponse[] = [];
    const responseGenerator = agent.testCallLlmAsync(
      invocationContext,
      llmRequest,
      modelResponseEvent,
    );

    for await (const response of agent.testRunAndHandleError(
      responseGenerator,
      invocationContext,
      llmRequest,
      modelResponseEvent,
    )) {
      responses.push(response);
    }
    return responses;
  }

  it('short circuits when before model plugin callback returns a response', async () => {
    pluginManager.registerPlugin(mockPlugin);
    mockPlugin.beforeModelResponse = beforePluginResponse;
    const result = await callLlmUnderTest();
    expect(result).toEqual([beforePluginResponse]);
  });

  it('uses canonical before model callback when plugin returns undefined', async () => {
    agent.beforeModelCallback = async () => beforeCallbackResponse;
    const result = await callLlmUnderTest();
    expect(result).toEqual([beforeCallbackResponse]);
  });

  it('uses plugin after model callback to override response', async () => {
    pluginManager.registerPlugin(mockPlugin);
    agent.model = new MockLlm(originalLlmResponse);
    mockPlugin.afterModelResponse = afterPluginResponse;
    const result = await callLlmUnderTest();
    expect(result).toEqual([afterPluginResponse]);
  });

  it('uses canonical after model callback when plugin returns undefined', async () => {
    agent.afterModelCallback = async () => afterCallbackResponse;
    agent.model = new MockLlm(originalLlmResponse);
    const result = await callLlmUnderTest();
    expect(result).toEqual([afterCallbackResponse]);
  });

  it('uses plugin on model error callback to handle LLM error', async () => {
    pluginManager.registerPlugin(mockPlugin);
    agent.model = new MockLlm(null, modelError);
    mockPlugin.onModelErrorResponse = onModelErrorPluginResponse;
    const result = await callLlmUnderTest();
    expect(result).toEqual([onModelErrorPluginResponse]);
  });

  it('propagates LLM error message when no plugin callback is present', async () => {
    agent.model = new MockLlm(null, modelError);
    const result = await callLlmUnderTest();
    expect(result).toEqual([{errorCode: '500', errorMessage: 'LLM error'}]);
  });
});

describe('LlmAgent Schema Initialization', () => {
  it('should initialize inputSchema from Schema object', () => {
    const inputSchema: Schema = {
      type: Type.OBJECT,
      properties: {foo: {type: Type.STRING}},
    };
    const agent = new LlmAgent({name: 'test', inputSchema});
    expect(agent.inputSchema).toEqual(inputSchema);
  });

  it('should initialize inputSchema from Zod v4 object', () => {
    const zodSchema = z4.object({foo: z4.string()});
    const agent = new LlmAgent({
      name: 'test',
      inputSchema: zodSchema,
    });
    expect(agent.inputSchema).toBeDefined();
    expect((agent.inputSchema as Schema).type).toBe('OBJECT');
    expect((agent.inputSchema as Schema).properties?.foo?.type).toBe('STRING');
  });

  it('should initialize inputSchema from Zod v3 object', () => {
    const zodSchema = z3.object({
      foo: z3.string(),
    });
    const agent = new LlmAgent({
      name: 'test',
      inputSchema: zodSchema,
    });
    expect(agent.inputSchema).toBeDefined();
    expect((agent.inputSchema as Schema).type).toBe('OBJECT');
    expect((agent.inputSchema as Schema).properties?.foo?.type).toBe('STRING');
  });

  it('should initialize outputSchema from Schema object', () => {
    const outputSchema: Schema = {
      type: Type.OBJECT,
      properties: {bar: {type: Type.NUMBER}},
    };
    const agent = new LlmAgent({name: 'test', outputSchema});
    expect(agent.outputSchema).toEqual(outputSchema);
  });

  it('should initialize outputSchema from Zod z4 object', () => {
    const zodSchema = z4.object({bar: z4.number()});
    const agent = new LlmAgent({
      name: 'test',
      outputSchema: zodSchema,
    });
    expect(agent.outputSchema).toBeDefined();
    expect((agent.outputSchema as Schema).type).toBe('OBJECT');
    expect((agent.outputSchema as Schema).properties?.bar?.type).toBe('NUMBER');
  });

  it('should initialize outputSchema from Zod v3 object', () => {
    const zodSchema = z3.object({
      bar: z3.number(),
    });
    const agent = new LlmAgent({
      name: 'test',
      outputSchema: zodSchema,
    });
    expect(agent.outputSchema).toBeDefined();
    expect((agent.outputSchema as Schema).type).toBe('OBJECT');
    expect((agent.outputSchema as Schema).properties?.bar?.type).toBe('NUMBER');
  });

  it('should enforce transfer restrictions when outputSchema is present', () => {
    const outputSchema: Schema = {type: Type.OBJECT};
    const agent = new LlmAgent({
      name: 'test',
      outputSchema,
      disallowTransferToParent: false,
      disallowTransferToPeers: false,
    });
    expect(agent.disallowTransferToParent).toBe(true);
    expect(agent.disallowTransferToPeers).toBe(true);
  });
});

describe('LlmAgent Output Processing', () => {
  let agent: LlmAgent;
  let invocationContext: InvocationContext;
  let validationSchema: Schema;

  beforeEach(() => {
    validationSchema = {
      type: Type.OBJECT,
      properties: {
        answer: {type: Type.STRING},
      },
    };
    agent = new LlmAgent({
      name: 'test_agent',
      outputSchema: validationSchema,
      outputKey: 'result',
    });
    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
    });
  });

  it('should save parsed JSON output to state based on outputKey', async () => {
    const jsonOutput = JSON.stringify({answer: '42'});
    const response: LlmResponse = {
      content: {parts: [{text: jsonOutput}]},
    };
    agent.model = new MockLlm(response);

    const generator = agent.runAsync(invocationContext);
    const events: Event[] = [];
    for await (const event of generator) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent).toBeDefined();
    expect(lastEvent.content?.parts?.[0].text).toEqual(jsonOutput);
    expect(lastEvent.actions?.stateDelta).toBeDefined();
    expect(lastEvent.actions?.stateDelta?.['result']).toEqual({answer: '42'});
  });

  it('should not save output if invalid JSON', async () => {
    const invalidJson = '{answer: 42'; // Missing closing brace
    const response: LlmResponse = {
      content: {parts: [{text: invalidJson}]},
    };
    agent.model = new MockLlm(response);

    const generator = agent.runAsync(invocationContext);
    const events: Event[] = [];
    for await (const event of generator) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent.actions?.stateDelta?.['result']).toEqual(invalidJson);
  });
});

describe('LlmAgent Configuration with contextCompactors', () => {
  it('does not add ContextCompactorRequestProcessor if contextCompactors is not provided', () => {
    const agent = new LlmAgent({name: 'test_agent'});
    const compactorProcessors = agent.requestProcessors.filter(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(compactorProcessors.length).toBe(0);
  });

  it('does not add ContextCompactorRequestProcessor if contextCompactors is empty array', () => {
    const agent = new LlmAgent({name: 'test_agent', contextCompactors: []});
    const compactorProcessors = agent.requestProcessors.filter(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(compactorProcessors.length).toBe(0);
  });

  it('does not add ContextCompactorRequestProcessor if custom requestProcessors are provided', () => {
    const mockCompactor = {
      shouldCompact: () => false,
      compact: () => {},
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      contextCompactors: [mockCompactor],
      requestProcessors: [], // custom processors
    });
    const compactorProcessors = agent.requestProcessors.filter(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(compactorProcessors.length).toBe(0);
  });

  it('adds ContextCompactorRequestProcessor immediately before CONTENT_REQUEST_PROCESSOR', () => {
    const mockCompactor = {
      shouldCompact: () => false,
      compact: () => {},
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      contextCompactors: [mockCompactor],
    });

    const processorIndex = agent.requestProcessors.findIndex(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(processorIndex).toBeGreaterThanOrEqual(0);

    // Ensure it was placed right before CONTENT_REQUEST_PROCESSOR
    const contentIndex = agent.requestProcessors.indexOf(
      CONTENT_REQUEST_PROCESSOR,
    );
    expect(contentIndex).toBe(processorIndex + 1);
  });
});

describe('LlmAgent Abort Handling', () => {
  it('should stop execution when abortSignal is aborted between steps', async () => {
    const responseChunks: LlmResponse[] = [
      {content: {parts: [{text: 'chunk 1'}]}},
      {content: {parts: [{text: 'chunk 2'}]}},
      {content: {parts: [{text: 'chunk 3'}]}},
      {content: {parts: [{text: 'chunk 4'}]}},
      {content: {parts: [{text: 'chunk 5'}]}},
    ];
    const mockModel = new StreamingMockLlm(responseChunks);
    const agent = new LlmAgent({name: 'test_agent', model: mockModel});

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const abortController = new AbortController();
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const firstResult = await generator.next();
    expect(firstResult.done).toBe(false);
    expect((firstResult.value as Event).content?.parts?.[0].text).toBe(
      'chunk 1',
    );

    abortController.abort();

    const secondResult = await generator.next();
    expect(secondResult.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during request processors', async () => {
    const mockProcessor = new MockRequestProcessor();
    const agent = new LlmAgent({
      name: 'test_agent',
      requestProcessors: [mockProcessor],
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const abortController = new AbortController();
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const firstResult = await generator.next();
    expect(firstResult.done).toBe(false);
    expect((firstResult.value as Event).author).toBe('processor');

    abortController.abort();

    const secondResult = await generator.next();
    expect(secondResult.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during tool processing', async () => {
    const abortController = new AbortController();
    const mockTool = new MockTool('mock_tool', abortController);
    const agent = new LlmAgent({
      name: 'test_agent',
      tools: [mockTool],
      model: new MockLlm(null),
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const result = await generator.next();
    expect(result.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during after model callback', async () => {
    const abortController = new AbortController();
    const mockModel = new MockLlm({
      content: {parts: [{text: 'mock response'}]},
    });
    const agent = new LlmAgent({
      name: 'test_agent',
      model: mockModel,
    });

    agent.afterModelCallback = async () => {
      abortController.abort();
      return undefined;
    };

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const result = await generator.next();
    expect(result.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during tool invocation', async () => {
    const abortController = new AbortController();
    const mockTool = new MockToolWithRun('mock_tool', abortController);

    const functionCallResponse: LlmResponse = {
      content: {
        parts: [
          {
            functionCall: {
              name: 'mock_tool',
              args: {},
            },
          },
        ],
      },
    };

    const mockModel = new MockLlm(functionCallResponse);
    const agent = new LlmAgent({
      name: 'test_agent',
      tools: [mockTool],
      model: mockModel,
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const firstResult = await generator.next();
    expect(firstResult.done).toBe(false);
    expect(
      (firstResult.value as Event).content?.parts?.[0].functionCall?.name,
    ).toBe('mock_tool');

    const secondResult = await generator.next();
    expect(secondResult.done).toBe(true);
  });

  it('should stop execution when abortSignal is aborted during response processors', async () => {
    const mockProcessor = new MockResponseProcessor();
    const agent = new LlmAgent({
      name: 'test_agent',
      responseProcessors: [mockProcessor],
      model: new MockLlm({content: {parts: [{text: 'mock response'}]}}),
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const abortController = new AbortController();
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const generator = agent.runAsync(invocationContext);

    const firstResult = await generator.next();
    expect(firstResult.done).toBe(false);
    expect((firstResult.value as Event).author).toBe('processor');

    abortController.abort();

    const secondResult = await generator.next();
    expect(secondResult.done).toBe(true);
  });
});

describe('LlmAgent postprocess empty parts filtering', () => {
  it('should not yield an event when LLM response has empty parts array', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({
        content: {role: 'model', parts: []},
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 0,
          totalTokenCount: 10,
        },
        finishReason: 'STOP' as never,
        partial: false,
      }),
    });
    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent,
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });
});

describe('LlmAgent Default Request Processors', () => {
  it('includes AUTH_PREPROCESSOR in default requestProcessors before CONTENT_REQUEST_PROCESSOR', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
    });
    expect(agent.requestProcessors).toContain(AUTH_PREPROCESSOR);
    const authIndex = agent.requestProcessors.indexOf(AUTH_PREPROCESSOR);
    const contentIndex = agent.requestProcessors.indexOf(
      CONTENT_REQUEST_PROCESSOR,
    );
    expect(authIndex).toBeLessThan(contentIndex);
  });
});

class MockToolWithAuth extends BaseTool {
  constructor(
    name: string,
    private authConfigsToRequest: Record<string, AuthConfig>,
    private controller?: AbortController,
  ) {
    super({name, description: 'mock tool with auth'});
  }
  async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    if (this.controller) {
      this.controller.abort();
    }
    if (request.toolContext && request.toolContext.functionCallId) {
      const config =
        this.authConfigsToRequest[request.toolContext.functionCallId];
      if (config) {
        request.toolContext.requestCredential(config);
      }
    }
    return Promise.resolve({result: 'auth_requested'});
  }
  override async processLlmRequest(
    params: ToolProcessLlmRequest,
  ): Promise<void> {
    params.llmRequest.toolsDict[this.name] = this;
  }
}

describe('LlmAgent generateAuthEvent internalization handling', () => {
  it('should emit auth request event when tool requests credentials during execution', async () => {
    const authConfig1: AuthConfig = {
      authScheme: {type: 'apiKey'},
    };
    const authConfig2: AuthConfig = {
      authScheme: {type: 'apiKey'},
    };

    const mockTool = new MockToolWithAuth('mock_tool_auth', {
      'call_1': authConfig1,
      'call_2': authConfig2,
    });

    const functionCallResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'mock_tool_auth',
              args: {arg: 1},
              id: 'call_1',
            },
          },
          {
            functionCall: {
              name: 'mock_tool_auth',
              args: {arg: 2},
              id: 'call_2',
            },
          },
        ],
      },
    };

    const mockModel = new MockLlm(functionCallResponse);
    const agent = new LlmAgent({
      name: 'test_agent',
      tools: [mockTool],
      model: mockModel,
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      branch: 'test_branch',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
    });

    const generator = agent.runAsync(invocationContext);
    const events: Event[] = [];
    for await (const event of generator) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(2);
    const authEvent = events.find((e) =>
      e.content?.parts?.some(
        (p) => p.functionCall?.name === REQUEST_EUC_FUNCTION_CALL_NAME,
      ),
    );
    expect(authEvent).toBeDefined();
    expect(authEvent!.invocationId).toBe('inv_123');
    expect(authEvent!.author).toBe('test_agent');
    expect(authEvent!.branch).toBe('test_branch');
    expect(authEvent!.longRunningToolIds).toHaveLength(2);
    expect(authEvent!.content!.parts!).toHaveLength(2);

    const call1Part = authEvent!.content!.parts!.find(
      (p) => p.functionCall?.args?.['function_call_id'] === 'call_1',
    );
    expect(call1Part).toBeDefined();
    expect(call1Part!.functionCall!.name).toBe(REQUEST_EUC_FUNCTION_CALL_NAME);
    expect(call1Part!.functionCall!.args!['auth_config']).toBeDefined();

    const call2Part = authEvent!.content!.parts!.find(
      (p) => p.functionCall?.args?.['function_call_id'] === 'call_2',
    );
    expect(call2Part).toBeDefined();
    expect(call2Part!.functionCall!.name).toBe(REQUEST_EUC_FUNCTION_CALL_NAME);
    expect(call2Part!.functionCall!.args!['auth_config']).toBeDefined();
  });

  it('should not emit auth request event when requestedAuthConfigs is empty', async () => {
    const abortController = new AbortController();
    const mockTool = new MockToolWithAuth(
      'mock_tool_no_auth',
      {},
      abortController,
    );

    const functionCallResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'mock_tool_no_auth',
              args: {},
              id: 'call_no_auth',
            },
          },
        ],
      },
    };

    const mockModel = new MockLlm(functionCallResponse);
    const agent = new LlmAgent({
      name: 'test_agent',
      tools: [mockTool],
      model: mockModel,
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      abortSignal: abortController.signal,
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    const authEvent = events.find((e) =>
      e.content?.parts?.some(
        (p) => p.functionCall?.name === REQUEST_EUC_FUNCTION_CALL_NAME,
      ),
    );
    expect(authEvent).toBeUndefined();
  });
});
