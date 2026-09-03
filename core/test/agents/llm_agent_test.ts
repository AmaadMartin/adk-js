/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  BaseCodeExecutor,
  BaseLlm,
  BaseLlmConnection,
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
  BasePlugin,
  BaseTool,
  BaseToolset,
  CodeExecutionResult,
  CONTENT_REQUEST_PROCESSOR,
  Context,
  CONTEXT_CACHE_REQUEST_PROCESSOR,
  ContextCompactorRequestProcessor,
  createEvent,
  createSession,
  Event,
  ExecuteCodeParams,
  FunctionTool,
  InMemoryArtifactService,
  InMemorySessionService,
  INTERACTIONS_REQUEST_PROCESSOR,
  InvocationContext,
  LlmAgent,
  LlmCapabilities,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  LongRunningFunctionTool,
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
  OUTPUT_SCHEMA_REQUEST_PROCESSOR,
  PlanReActPlanner,
  PluginManager,
  ReadonlyContext,
  RunAsyncToolRequest,
  Runner,
  Session,
  SingleFlow,
  ToolProcessLlmRequest,
} from '@google/adk';
import {Content, Schema, Type} from '@google/genai';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/agent_transfer_llm_request_processor.js';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  responseProcessor as CODE_EXECUTION_RESPONSE_PROCESSOR,
} from '../../src/agents/processors/code_execution_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/instructions_llm_request_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../src/agents/processors/request_confirmation_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from '../../src/agents/processors/tool_filter_request_processor.js';
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {appendDynamicInstructions} from '../../src/models/llm_request.js';
import {logger} from '../../src/utils/logger.js';

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

/**
 * Records the single request an agent builds, so one run of the default
 * processor chain can be asserted against.
 */
class CapturingLlm extends BaseLlm {
  capturedRequest?: LlmRequest;

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.capturedRequest = request;
    yield {content: {role: 'model', parts: [{text: '{"answer": "42"}'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
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

/**
 * Yields the chunks of `turns[n]` on the n-th call and counts how many turns
 * the agent asked for.
 */
class CountingMockLlm extends BaseLlm {
  callCount = 0;

  constructor(private readonly turns: LlmResponse[][]) {
    super({model: 'counting-mock-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield* this.turns[this.callCount++] ?? [];
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

  it('validates output against a genai outputSchema', () => {
    const agent = new LlmAgent({
      name: 'test',
      outputSchema: {
        type: Type.OBJECT,
        properties: {bar: {type: Type.NUMBER}},
        required: ['bar'],
      },
    });
    expect(agent.validateOutput({bar: 1})).toEqual({bar: 1});
    expect(() => agent.validateOutput({bar: 'no'})).toThrow();
  });

  it('validates output against a Zod outputSchema, keeping its refinements', () => {
    const agent = new LlmAgent({
      name: 'test',
      outputSchema: z4.object({bar: z4.number().refine((n) => n > 10)}),
    });
    expect(agent.validateOutput({bar: 11})).toEqual({bar: 11});
    // The refinement survives only because the original Zod schema is kept;
    // it has no representation in the converted genai Schema.
    expect(() => agent.validateOutput({bar: 1})).toThrow();
  });

  it('keeps the supplied schema alongside the converted genai form', () => {
    const zodSchema = z4.object({bar: z4.number()});
    const agent = new LlmAgent({name: 'test', outputSchema: zodSchema});
    expect(agent.outputSchemaSource).toBe(zodSchema);
    expect((agent.outputSchema as Schema).type).toBe('OBJECT');
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

  it('warns about transfer only when transfer was asked for explicitly', () => {
    const outputSchema: Schema = {type: Type.OBJECT};
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const quiet = new LlmAgent({name: 'quiet', outputSchema});
    expect(warnSpy).not.toHaveBeenCalled();
    expect(quiet.disallowTransferToParent).toBe(true);
    expect(quiet.disallowTransferToPeers).toBe(true);

    new LlmAgent({
      name: 'loud',
      outputSchema,
      disallowTransferToPeers: false,
    });
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });

  it('warns about transfer when outputSchema co-exists with subAgents', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const agent = new LlmAgent({
      name: 'parent',
      outputSchema: {type: Type.OBJECT},
      subAgents: [new LlmAgent({name: 'child'})],
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(agent.disallowTransferToPeers).toBe(true);
    warnSpy.mockRestore();
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

  it('saves the parsed object when the model fences its JSON reply', async () => {
    const response: LlmResponse = {
      content: {parts: [{text: '```json\n{"answer": "42"}\n```'}]},
    };
    agent.model = new MockLlm(response);

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent.actions?.stateDelta?.['result']).toEqual({answer: '42'});
  });

  it('keeps the parsed object in state when it violates the output schema', async () => {
    // Well-formed JSON, but `answer` is declared STRING. The violation is
    // logged rather than thrown, and state keeps the object the model
    // returned — a consumer of `outputKey` reads the same type either way.
    const response: LlmResponse = {
      content: {parts: [{text: JSON.stringify({answer: 42})}]},
    };
    agent.model = new MockLlm(response);

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    const lastEvent = events[events.length - 1];
    expect(lastEvent.actions?.stateDelta?.['result']).toEqual({answer: 42});
  });
});

describe('LlmAgent Configuration with contextCompactors', () => {
  it('adds one ContextCompactorRequestProcessor if contextCompactors is not provided', () => {
    const agent = new LlmAgent({name: 'test_agent'});
    const compactorProcessors = agent.requestProcessors.filter(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(compactorProcessors.length).toBe(1);
  });

  it('adds one ContextCompactorRequestProcessor if contextCompactors is empty array', () => {
    const agent = new LlmAgent({name: 'test_agent', contextCompactors: []});
    const compactorProcessors = agent.requestProcessors.filter(
      (p) => p instanceof ContextCompactorRequestProcessor,
    );
    expect(compactorProcessors.length).toBe(1);
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

describe('LlmAgent flow selection', () => {
  it('omits agent transfer when a leaf agent forbids every direction', () => {
    const agent = new LlmAgent({
      name: 'leaf_agent',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });

    expect(agent.requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('adds agent transfer last when transfer stays allowed', () => {
    const agent = new LlmAgent({name: 'default_agent'});

    expect(agent.requestProcessors[agent.requestProcessors.length - 1]).toBe(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('adds agent transfer when an agent has sub-agents despite the flags', () => {
    const agent = new LlmAgent({
      name: 'parent_agent',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      subAgents: [new LlmAgent({name: 'child_agent'})],
    });

    expect(agent.requestProcessors).toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('appends agent transfer to a caller-supplied pipeline', () => {
    const agent = new LlmAgent({
      name: 'custom_agent',
      requestProcessors: [CONTENT_REQUEST_PROCESSOR],
    });

    expect(agent.requestProcessors).toEqual([
      CONTENT_REQUEST_PROCESSOR,
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    ]);
  });

  it('gives every agent its own processor arrays', () => {
    const first = new LlmAgent({name: 'first_agent'});
    const second = new LlmAgent({name: 'second_agent'});

    first.requestProcessors.push(CONTENT_REQUEST_PROCESSOR);

    expect(first.requestProcessors).toHaveLength(
      second.requestProcessors.length + 1,
    );
    expect(first.responseProcessors).not.toBe(second.responseProcessors);
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

describe('LlmAgent long running tool termination', () => {
  const startJobCall: LlmResponse = {
    content: {
      role: 'model',
      parts: [{functionCall: {name: 'startJob', args: {}, id: 'call_1'}}],
    },
  };
  const secondTurnText: LlmResponse = {
    content: {role: 'model', parts: [{text: 'second turn'}]},
  };

  function runAgent(model: BaseLlm, startJob: LongRunningFunctionTool) {
    const agent = new LlmAgent({name: 'test_agent', model, tools: [startJob]});
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: createSession({id: 'sess_123', appName: 'test_app'}),
      agent,
      pluginManager: new PluginManager(),
    });
    return agent.runAsync(invocationContext);
  }

  function createStartJobTool(mutate?: (toolContext: Context) => void) {
    return new LongRunningFunctionTool({
      name: 'startJob',
      description: 'starts a background job',
      execute: async (_args, toolContext) => {
        mutate?.(toolContext!);
        return undefined;
      },
    });
  }

  it('should stop the step loop after an actions-only event', async () => {
    const model = new CountingMockLlm([[startJobCall], [secondTurnText]]);
    const startJob = createStartJobTool((toolContext) => {
      toolContext.actions.skipSummarization = true;
    });

    const events: Event[] = [];
    for await (const event of runAgent(model, startJob)) {
      events.push(event);
    }

    expect(model.callCount).toBe(1);
    expect(
      events.some((event) =>
        event.content?.parts?.some((part) => part.text === 'second turn'),
      ),
    ).toBe(false);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.content).toBeUndefined();
    expect(lastEvent.actions.skipSummarization).toBe(true);
  });

  it('should keep running the step loop after a trailing empty chunk with default actions', async () => {
    const model = new CountingMockLlm([
      [startJobCall, {content: {role: 'model'}}],
      [secondTurnText],
    ]);

    const events: Event[] = [];
    for await (const event of runAgent(model, createStartJobTool())) {
      events.push(event);
    }

    expect(model.callCount).toBe(2);
    expect(events[events.length - 1].content?.parts?.[0].text).toBe(
      'second turn',
    );
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

  it('resolves the interaction chain id before building the contents', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
    });
    const interactionsIndex = agent.requestProcessors.indexOf(
      INTERACTIONS_REQUEST_PROCESSOR,
    );
    const contentIndex = agent.requestProcessors.indexOf(
      CONTENT_REQUEST_PROCESSOR,
    );
    expect(interactionsIndex).toBeGreaterThanOrEqual(0);
    expect(interactionsIndex).toBeLessThan(contentIndex);
  });

  it('runs NL_PLANNING_REQUEST_PROCESSOR after contents and before code execution', () => {
    const agent = new LlmAgent({name: 'test_agent'});

    const contentIndex = agent.requestProcessors.indexOf(
      CONTENT_REQUEST_PROCESSOR,
    );
    const planningIndex = agent.requestProcessors.indexOf(
      NL_PLANNING_REQUEST_PROCESSOR,
    );
    const codeExecutionIndex = agent.requestProcessors.indexOf(
      CODE_EXECUTION_REQUEST_PROCESSOR,
    );
    expect(planningIndex).toBeGreaterThan(contentIndex);
    expect(planningIndex).toBeLessThan(codeExecutionIndex);
  });
});

describe('LlmAgent Single Flow Defaults', () => {
  it('runs INTERACTIONS_REQUEST_PROCESSOR before CONTENT_REQUEST_PROCESSOR', () => {
    const agent = new LlmAgent({name: 'test_agent'});

    const interactionsIndex = agent.requestProcessors.indexOf(
      INTERACTIONS_REQUEST_PROCESSOR,
    );
    const contentIndex = agent.requestProcessors.indexOf(
      CONTENT_REQUEST_PROCESSOR,
    );
    expect(interactionsIndex).toBeGreaterThanOrEqual(0);
    expect(interactionsIndex).toBeLessThan(contentIndex);
  });

  it('takes its default pipeline from SingleFlow when transfer is disabled', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });

    expect(agent.requestProcessors).toStrictEqual(
      new SingleFlow().requestProcessors,
    );
  });

  it('appends the agent transfer processor when transfer is enabled', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      subAgents: [new LlmAgent({name: 'sub_agent'})],
    });

    expect(agent.requestProcessors).toStrictEqual([
      ...new SingleFlow().requestProcessors,
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    ]);
  });

  it('takes its default response pipeline from SingleFlow', () => {
    const agent = new LlmAgent({name: 'test_agent'});

    expect(agent.responseProcessors).toStrictEqual(
      new SingleFlow().responseProcessors,
    );
  });

  it('defaults responseProcessors to the code execution response processor', () => {
    const agent = new LlmAgent({name: 'test_agent'});

    expect(agent.responseProcessors).toContain(
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    );
  });

  it('runs NL_PLANNING_RESPONSE_PROCESSOR before the code execution response processor', () => {
    const agent = new LlmAgent({name: 'test_agent'});

    expect(agent.responseProcessors).toEqual([
      NL_PLANNING_RESPONSE_PROCESSOR,
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    ]);
  });

  it('keeps an explicitly empty responseProcessors list empty', () => {
    const agent = new LlmAgent({name: 'test_agent', responseProcessors: []});

    expect(agent.responseProcessors).toEqual([]);
  });

  it('gives each agent its own requestProcessors array', () => {
    const first = new LlmAgent({name: 'first_agent'});
    const second = new LlmAgent({name: 'second_agent'});

    expect(first.requestProcessors).not.toBe(second.requestProcessors);
    first.requestProcessors.push(CONTENT_REQUEST_PROCESSOR);
    expect(
      second.requestProcessors.filter(
        (processor) => processor === CONTENT_REQUEST_PROCESSOR,
      ),
    ).toHaveLength(1);
  });
});

describe('LlmAgent planner', () => {
  it('round-trips the planner from the config', () => {
    const planner = new PlanReActPlanner();

    const agent = new LlmAgent({name: 'test_agent', planner});

    expect(agent.planner).toBe(planner);
  });

  it('leaves planner undefined when the config omits it', () => {
    const agent = new LlmAgent({name: 'test_agent'});

    expect(agent.planner).toBeUndefined();
  });
});

describe('LlmAgent default processor pipeline order', () => {
  /** Where a processor sits in a default agent's pipeline. */
  function positionOf(processor: BaseLlmRequestProcessor): number {
    return new LlmAgent({name: 'test_agent'}).requestProcessors.indexOf(
      processor,
    );
  }

  it('runs request confirmation, then the instruction, then the identity preamble', () => {
    expect(positionOf(REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR)).toBeLessThan(
      positionOf(INSTRUCTIONS_LLM_REQUEST_PROCESSOR),
    );
    expect(positionOf(INSTRUCTIONS_LLM_REQUEST_PROCESSOR)).toBeLessThan(
      positionOf(IDENTITY_LLM_REQUEST_PROCESSOR),
    );
  });

  it('runs the context cache processor immediately after the contents', () => {
    expect(positionOf(CONTEXT_CACHE_REQUEST_PROCESSOR)).toBe(
      positionOf(CONTENT_REQUEST_PROCESSOR) + 1,
    );
  });

  it('runs the output schema processor immediately after code execution', () => {
    expect(positionOf(OUTPUT_SCHEMA_REQUEST_PROCESSOR)).toBe(
      positionOf(CODE_EXECUTION_REQUEST_PROCESSOR) + 1,
    );
  });

  it('assembles the agent instruction before the identity preamble', async () => {
    const llm = new CapturingLlm({model: 'gemini-2.5-flash'});
    const agent = new LlmAgent({
      name: 'ordered_agent',
      model: llm,
      instruction: 'Answer weather questions.',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_order',
      session: createSession({
        id: 'sess_order',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    for await (const _ of agent.runAsync(invocationContext)) {
      // Drain the run so that the request is fully built.
    }

    const systemInstruction = String(
      llm.capturedRequest?.config?.systemInstruction ?? '',
    );
    const identityPreamble = 'You are an agent. Your internal name is';
    expect(systemInstruction).toContain('Answer weather questions.');
    expect(systemInstruction).toContain(identityPreamble);
    expect(systemInstruction.indexOf('Answer weather questions.')).toBeLessThan(
      systemInstruction.indexOf(identityPreamble),
    );
  });

  it('gives an agent exactly the processors it supplied', () => {
    const supplied = [CONTEXT_CACHE_REQUEST_PROCESSOR];

    const agent = new LlmAgent({
      name: 'test_agent',
      requestProcessors: supplied,
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });

    expect(agent.requestProcessors).toEqual(supplied);
  });

  it('injects no compaction processor into a caller-supplied pipeline', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      requestProcessors: [AUTH_PREPROCESSOR],
      contextCompactors: [{shouldCompact: () => true, compact: () => {}}],
    });

    expect(agent.requestProcessors).toStrictEqual([AUTH_PREPROCESSOR]);
  });

  // Agent transfer is appended after the shared list, as adk-python's AutoFlow
  // appends it after single_flow's, so it is disabled here.
  it('ends the shared processor list with the output schema processor, ahead of the tool filter', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });

    expect(agent.requestProcessors.slice(-2)).toEqual([
      OUTPUT_SCHEMA_REQUEST_PROCESSOR,
      TOOL_FILTER_REQUEST_PROCESSOR,
    ]);
  });
});

describe('LlmAgent outputSchema with tools', () => {
  const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

  const OUTPUT_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {answer: {type: Type.STRING}},
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A model that declares a capability its name would not reveal. */
  class DeclaringLlm extends CapturingLlm {
    override get capabilities(): LlmCapabilities {
      return {outputSchemaAndTools: true};
    }
  }

  async function captureRequest(options: {
    model: string;
    withTools: boolean;
    mode?: 'single_turn' | 'task';
    declaresCapability?: boolean;
  }): Promise<LlmRequest> {
    const llm = options.declaresCapability
      ? new DeclaringLlm({model: options.model})
      : new CapturingLlm({model: options.model});
    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      instruction: 'Base instruction',
      mode: options.mode,
      outputSchema: OUTPUT_SCHEMA,
      tools: options.withTools
        ? [
            new FunctionTool({
              name: 'some_tool',
              description: 'A test tool',
              execute: () => 'result',
            }),
          ]
        : [],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: createSession({
        id: 'sess_123',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    for await (const _ of agent.runAsync(invocationContext)) {
      // Drain the run so that the request is fully built.
    }

    const request = llm.capturedRequest;
    if (!request) {
      expect.fail('the agent never called the model');
    }
    return request;
  }

  it('uses the native response schema on Vertex AI with a Gemini 2.0+ model', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    const request = await captureRequest({
      model: 'gemini-2.5-flash',
      withTools: true,
    });

    expect(request.config?.responseSchema).toBeDefined();
    expect(request.config?.responseMimeType).toBe('application/json');
    expect(request.toolsDict).not.toHaveProperty('set_model_response');
    expect(request.toolsDict).toHaveProperty('some_tool');
    expect(request.config?.systemInstruction).not.toContain(
      'set_model_response',
    );
  });

  it('uses the set_model_response workaround outside the Vertex AI variant', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const request = await captureRequest({
      model: 'gemini-2.5-flash',
      withTools: true,
    });

    expect(request.config?.responseSchema).toBeUndefined();
    expect(request.toolsDict).toHaveProperty('set_model_response');
    expect(request.toolsDict).toHaveProperty('some_tool');
    expect(request.config?.systemInstruction).toContain('set_model_response');
  });

  it('uses the set_model_response workaround on Vertex AI with a pre-2.0 model', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    const request = await captureRequest({
      model: 'gemini-1.5-pro',
      withTools: true,
    });

    expect(request.config?.responseSchema).toBeUndefined();
    expect(request.toolsDict).toHaveProperty('set_model_response');
    expect(request.config?.systemInstruction).toContain('set_model_response');
  });

  it('gives a task-mode agent finish_task and no set_model_response', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const request = await captureRequest({
      model: 'gemini-2.5-flash',
      withTools: true,
      mode: 'task',
    });

    expect(request.toolsDict).toHaveProperty('finish_task');
    expect(request.toolsDict).not.toHaveProperty('set_model_response');
    expect(request.config?.systemInstruction).not.toContain(
      'set_model_response',
    );
  });

  it('uses the native response schema when the model declares the capability', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const request = await captureRequest({
      model: 'openai/gpt-4o',
      withTools: true,
      declaresCapability: true,
    });

    expect(request.config?.responseSchema).toBeDefined();
    expect(request.toolsDict).not.toHaveProperty('set_model_response');
    expect(request.toolsDict).toHaveProperty('some_tool');
    expect(request.config?.systemInstruction).not.toContain(
      'set_model_response',
    );
  });

  it.each(['true', undefined])(
    'uses the native response schema without tools when %s',
    async (vertexEnv) => {
      vi.stubEnv(VERTEX_ENV_VAR, vertexEnv);

      const request = await captureRequest({
        model: 'gemini-2.5-flash',
        withTools: false,
      });

      expect(request.config?.responseSchema).toBeDefined();
      expect(request.toolsDict).not.toHaveProperty('set_model_response');
      expect(request.config?.systemInstruction).not.toContain(
        'set_model_response',
      );
    },
  );

  it('offers set_model_response even when allowedTools excludes it', async () => {
    // The tool reaches the model through toolsDict, which the allowedTools
    // filter never touches, so no exemption for its name is needed.
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const narrowAllowedTools = new (class extends BaseLlmRequestProcessor {
      // eslint-disable-next-line require-yield -- BaseLlmRequestProcessor mandates an AsyncGenerator; this processor only mutates the request.
      async *runAsync(
        _invocationContext: InvocationContext,
        request: LlmRequest,
      ): AsyncGenerator<Event, void, void> {
        request.allowedTools = ['nothing_matches_this'];
      }
    })();
    const llm = new CapturingLlm({model: 'gemini-2.5-flash'});
    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      outputSchema: OUTPUT_SCHEMA,
      tools: [
        new FunctionTool({
          name: 'some_tool',
          description: 'A test tool',
          execute: () => 'result',
        }),
      ],
      requestProcessors: [
        ...new SingleFlow().requestProcessors,
        narrowAllowedTools,
      ],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_allowed_tools',
      session: createSession({
        id: 'sess_allowed_tools',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    for await (const _ of agent.runAsync(invocationContext)) {
      // Drain the run so that the request is fully built.
    }

    const request = llm.capturedRequest;
    if (!request) {
      expect.fail('the agent never called the model');
    }
    expect(request.toolsDict).toHaveProperty('set_model_response');
    expect(request.toolsDict).not.toHaveProperty('some_tool');
  });

  it('persists state writes made in processLlmRequest across turns', async () => {
    class StateProbeTool extends BaseTool {
      constructor() {
        super({name: 'state_probe_tool', description: 'test probe'});
      }
      override _getDeclaration() {
        return {
          name: this.name,
          description: this.description,
          parameters: {type: Type.OBJECT, properties: {}},
        };
      }
      override async processLlmRequest(
        request: ToolProcessLlmRequest,
      ): Promise<void> {
        await super.processLlmRequest(request);
        const {toolContext} = request;
        const current = toolContext.state.get<number>('probe_counter') ?? 0;
        toolContext.state.set('probe_counter', current + 1);
      }
      async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
        return Promise.resolve({result: 'ok'});
      }
    }

    const tool = new StateProbeTool();
    const mockLlm = new MockLlm({
      content: {role: 'model', parts: [{text: 'Done'}]},
    });
    const agent = new LlmAgent({
      name: 'probe_agent',
      model: mockLlm,
      tools: [tool],
    });

    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
    });

    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });

    for await (const _event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Turn 1'}]},
    })) {
      // Consume the stream
    }

    const sessionAfterTurn1 = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });
    expect(sessionAfterTurn1?.state?.['probe_counter']).toBe(1);

    for await (const _event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Turn 2'}]},
    })) {
      // Consume the stream
    }

    const sessionAfterTurn2 = await sessionService.getSession({
      appName: 'test_app',
      userId: 'test_user',
      sessionId: 'test_session',
    });
    expect(sessionAfterTurn2?.state?.['probe_counter']).toBe(2);
  });
});

describe('LlmAgent set_model_response round-trip', () => {
  const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

  const OUTPUT_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {answer: {type: Type.STRING}},
    required: ['answer'],
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Replays one scripted response per model turn, then a fixed sign-off. */
  class ScriptedLlm extends BaseLlm {
    turns = 0;

    constructor(
      private readonly script: LlmResponse[],
      model = 'gemini-2.5-flash',
    ) {
      super({model});
    }

    async *generateContentAsync(
      _request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      const response = this.script[this.turns];
      this.turns++;
      yield response ?? {
        content: {role: 'model', parts: [{text: 'no more turns'}]},
      };
    }

    async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  function callResponse(
    name: string,
    args: Record<string, unknown>,
  ): LlmResponse {
    return {content: {role: 'model', parts: [{functionCall: {name, args}}]}};
  }

  async function runAgent(options: {
    script: LlmResponse[];
    outputKey?: string;
  }): Promise<Event[]> {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new ScriptedLlm(options.script),
      outputSchema: OUTPUT_SCHEMA,
      outputKey: options.outputKey,
      tools: [
        new FunctionTool({
          name: 'some_tool',
          description: 'A test tool',
          execute: () => 'result',
        }),
      ],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: createSession({
        id: 'sess_123',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }
    return events;
  }

  /** Describes an event as `<kind>:<detail>`, so a stream reads at a glance. */
  function summarize(event: Event): string {
    const call = event.content?.parts?.[0]?.functionCall;
    if (call) {
      return `call:${call.name}`;
    }
    const response = event.content?.parts?.[0]?.functionResponse;
    if (response) {
      return `response:${response.name}`;
    }
    return `text:${event.content?.parts?.[0]?.text}`;
  }

  it('answers a valid call with the function response and then the JSON', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const events = await runAgent({
      script: [callResponse('set_model_response', {answer: 'forty two'})],
    });

    expect(events.map(summarize)).toEqual([
      'call:set_model_response',
      'response:set_model_response',
      'text:{"answer":"forty two"}',
    ]);
  });

  it('stops the run on the final event, without a further model turn', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const model = new ScriptedLlm([
      callResponse('set_model_response', {answer: 'forty two'}),
    ]);
    const agent = new LlmAgent({
      name: 'test_agent',
      model,
      outputSchema: OUTPUT_SCHEMA,
      tools: [
        new FunctionTool({
          name: 'some_tool',
          description: 'A test tool',
          execute: () => 'result',
        }),
      ],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: createSession({
        id: 'sess_123',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    for await (const _event of agent.runAsync(invocationContext)) {
      // Drain the run.
    }

    expect(model.turns).toBe(1);
  });

  it('answers a schema-violating call with the error alone, so the model retries', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const events = await runAgent({
      script: [
        callResponse('set_model_response', {answer: 42}),
        {content: {role: 'model', parts: [{text: 'plain answer'}]}},
      ],
    });

    expect(events.map(summarize)).toEqual([
      'call:set_model_response',
      'response:set_model_response',
      'text:plain answer',
    ]);
    const errorResponse = events[1].content?.parts?.[0]?.functionResponse
      ?.response as {error?: string};
    expect(errorResponse.error).toContain('Validation Error found:');
    expect(events[1].actions.setModelResponse).toBeUndefined();
  });

  it('answers an ordinary tool call with the function response alone', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const events = await runAgent({
      script: [
        callResponse('some_tool', {}),
        {content: {role: 'model', parts: [{text: 'plain answer'}]}},
      ],
    });

    expect(events.map(summarize)).toEqual([
      'call:some_tool',
      'response:some_tool',
      'text:plain answer',
    ]);
  });

  it('writes the parsed answer to the output key', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const events = await runAgent({
      script: [callResponse('set_model_response', {answer: 'forty two'})],
      outputKey: 'person',
    });

    expect(events[2].actions.stateDelta['person']).toEqual({
      answer: 'forty two',
    });
  });
});

describe('LlmAgent usage metadata on content-less responses', () => {
  let agent: LlmAgent;
  let invocationContext: InvocationContext;

  beforeEach(() => {
    agent = new LlmAgent({name: 'usage_test_agent'});
    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };
    invocationContext = new InvocationContext({
      invocationId: 'inv_usage',
      session: {
        id: 'sess_usage',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent,
      pluginManager: new PluginManager(),
    });
  });

  async function runAndCollect(): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }
    return events;
  }

  // In SSE streaming, StreamingResponseAggregator.close() reports a turn's
  // token counts on a response with no content, because the turn's parts were
  // already yielded. Skipping it loses that turn's usage entirely, and the loss
  // is silent: downstream, "no usage reported" and "zero tokens used" are the
  // same value.
  it('emits an event for a response that carries only usage metadata', async () => {
    const response: LlmResponse = {
      usageMetadata: {
        promptTokenCount: 1234,
        candidatesTokenCount: 56,
        totalTokenCount: 1290,
      },
    };
    agent.model = new MockLlm(response);

    const events = await runAndCollect();

    expect(events.length).toBeGreaterThan(0);
    const usageEvent = events.find((e) => e.usageMetadata);
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.usageMetadata?.promptTokenCount).toEqual(1234);
    expect(usageEvent!.usageMetadata?.candidatesTokenCount).toEqual(56);
  });

  // The event must NOT carry an empty parts array. That is what poisoned
  // session history and made Vertex reject the following request with HTTP 400
  // (#21, #22); buildContents() skips events without `content.role`, so an
  // undefined content keeps the usage out of history while still delivering it.
  it('does not emit empty-parts content alongside the usage', async () => {
    const response: LlmResponse = {
      usageMetadata: {promptTokenCount: 10, totalTokenCount: 10},
    };
    agent.model = new MockLlm(response);

    const events = await runAndCollect();

    const usageEvent = events.find((e) => e.usageMetadata);
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.content?.parts).toBeUndefined();
    expect(usageEvent!.content?.role).toBeUndefined();
  });

  // Control: without usage metadata the guard must still skip, or the fix would
  // start emitting events for genuinely empty responses.
  it('still skips a response with neither content nor usage metadata', async () => {
    agent.model = new MockLlm({} as LlmResponse);

    const events = await runAndCollect();

    expect(events.find((e) => e.usageMetadata)).toBeUndefined();
  });
});

describe('LlmAgent unresolvable tool calls', () => {
  /**
   * Calls a name that cannot resolve, then reacts to whatever came back — the
   * behaviour a real model has and the stub in the bug report deliberately
   * lacks.
   */
  class GhostCallerLlm extends BaseLlm {
    calls = 0;

    constructor() {
      super({model: 'mock-llm'});
    }

    async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.calls++;
      const answered = (request.contents ?? []).some((content) =>
        (content.parts ?? []).some(
          (part) =>
            (part.functionResponse?.response as {error?: string} | undefined)
              ?.error,
        ),
      );
      yield answered
        ? {content: {role: 'model', parts: [{text: 'Recovered.'}]}}
        : {
            content: {
              role: 'model',
              parts: [
                {functionCall: {id: 'call-1', name: 'ghost_tool', args: {}}},
              ],
            },
          };
    }

    async connect(): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  // The unit tests cover `handleFunctionCallList` directly, but #789 is a
  // whole-invocation symptom: the throw reached `runAndHandleError`, the turn
  // reported UNKNOWN_ERROR, and the unanswered call was re-issued until
  // `maxLlmCalls` tripped. Assert it here so reintroducing the escape one
  // layer up cannot stay green.
  it('completes the invocation instead of erroring and re-issuing the call', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    onTestFinished(() => warnSpy.mockRestore());
    const mockLlm = new GhostCallerLlm();
    const agent = new LlmAgent({
      name: 'ghost_agent',
      model: mockLlm,
      tools: [
        new FunctionTool({
          name: 'real_tool',
          description: 'The only registered tool.',
          parameters: z3.object({}),
          execute: async () => ({result: 'ok'}),
        }),
      ],
    });

    const sessionService = new InMemorySessionService();
    const runner = new Runner({appName: 'test_app', agent, sessionService});
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      events.push(event);
    }

    // No error event: this is a tool failure the turn recovers from, not a
    // model error that fails the invocation.
    expect(events.filter((e) => e.errorMessage)).toHaveLength(0);
    expect(events.filter((e) => e.errorCode)).toHaveLength(0);

    // Two model calls, not `maxLlmCalls` worth.
    expect(mockLlm.calls).toBe(2);

    const parts = events.flatMap((e) => e.content?.parts ?? []);
    const calls = parts.filter((p) => p.functionCall);
    const responses = parts.filter((p) => p.functionResponse);
    // Gemini rejects a dangling functionCall, so the pairing has to balance.
    expect(calls).toHaveLength(1);
    expect(responses).toHaveLength(1);
    expect(responses[0].functionResponse!.id).toBe('call-1');
    expect(responses[0].functionResponse!.name).toBe('ghost_tool');
    expect(responses[0].functionResponse!.response).toHaveProperty('error');

    expect(parts.some((p) => p.text === 'Recovered.')).toBe(true);
  });
});

describe('LlmAgent run config httpOptions', () => {
  /** Records the request the agent builds on the unary path. */
  class RequestCapturingLlm extends BaseLlm {
    capturedRequest?: LlmRequest;

    async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.capturedRequest = request;
      yield {content: {role: 'model', parts: [{text: 'done'}]}};
    }

    async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  it('reach the model request and win over the agent options', async () => {
    const llm = new RequestCapturingLlm({model: 'capture-http-options'});
    const agent = new LlmAgent({
      name: 'test_agent',
      model: llm,
      generateContentConfig: {
        httpOptions: {timeout: 1000, headers: {'Agent-Header': 'agent'}},
      },
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_http_options',
      session: createSession({
        id: 'sess_http_options',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
      runConfig: {
        httpOptions: {timeout: 5000, headers: {'RunConfig-Header': 'run'}},
        labels: {owner: 'run'},
      },
    });

    for await (const _ of agent.runAsync(invocationContext)) {
      // Drain the run so that the request is fully built.
    }

    expect(llm.capturedRequest?.config?.httpOptions).toEqual({
      timeout: 5000,
      headers: {'Agent-Header': 'agent', 'RunConfig-Header': 'run'},
    });
    expect(llm.capturedRequest?.config?.labels).toMatchObject({owner: 'run'});
  });
});

class FailingToolset extends BaseToolset {
  constructor() {
    super([]);
  }

  getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return Promise.reject(new Error('transport closed'));
  }

  async close(): Promise<void> {}
}

class WorkingToolset extends BaseToolset {
  constructor(private readonly tool: BaseTool) {
    super([]);
  }

  async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return [this.tool];
  }

  async close(): Promise<void> {}
}

describe('LlmAgent toolset load failures', () => {
  it('keeps the other tools and names the failed toolset in an error log', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    onTestFinished(() => errorSpy.mockRestore());
    const survivor = new FunctionTool({
      name: 'survivor',
      description: 'A tool from the toolset that loaded.',
      parameters: z3.object({}),
      execute: async () => ({result: 'ok'}),
    });
    const agent = new LlmAgent({
      name: 'resilient_agent',
      tools: [new FailingToolset(), new WorkingToolset(survivor)],
    });

    const tools = await agent.canonicalTools();

    expect(tools).toEqual([survivor]);
    expect(errorSpy).toHaveBeenCalledOnce();
    const [message, cause] = errorSpy.mock.calls[0];
    expect(message).toContain('FailingToolset');
    expect(message).toContain('<unknown>');
    expect(cause).toBeInstanceOf(Error);
  });

  it('names the agent when a readonly context is available', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    onTestFinished(() => errorSpy.mockRestore());
    const agent = new LlmAgent({
      name: 'named_agent',
      tools: [new FailingToolset()],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_toolset',
      session: createSession({id: 'sess_toolset', appName: 'app'}),
      agent,
      pluginManager: new PluginManager(),
    });

    const tools = await agent.canonicalTools(
      new ReadonlyContext(invocationContext),
    );

    expect(tools).toEqual([]);
    expect(errorSpy.mock.calls[0][0]).toContain('named_agent');
  });
});

/**
 * Budget (ms) for a test that re-evaluates the agent module graph. Well above
 * the ~5s it costs on a developer machine, because CI adds v8 coverage
 * instrumentation on slower runners.
 */
const MODULE_RELOAD_TIMEOUT_MS = 120_000;

class DefaultTestLlm extends BaseLlm {
  static override readonly supportedModels = ['default-test-llm'];

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {}

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

describe('LlmAgent default model', () => {
  beforeAll(() => {
    LLMRegistry.register(DefaultTestLlm);
  });

  // The override is process-global, so a leak would decide the model for
  // unrelated agents in the same worker.
  afterEach(() => {
    LlmAgent.setDefaultModel(undefined);
  });

  it('throws when no model, no ancestor and no override', () => {
    const agent = new LlmAgent({name: 'lonely_agent'});

    expect(() => agent.canonicalModel).toThrow(
      'No model found for lonely_agent.',
    );
  });

  it('resolves an override given as a model name', () => {
    LlmAgent.setDefaultModel('default-test-llm');
    const agent = new LlmAgent({name: 'named_override_agent'});

    expect(agent.canonicalModel).toBeInstanceOf(DefaultTestLlm);
    expect(agent.canonicalModel.model).toBe('default-test-llm');
  });

  it('returns the exact instance an override was given as', () => {
    const llm = new DefaultTestLlm({model: 'default-test-llm'});
    LlmAgent.setDefaultModel(llm);
    const agent = new LlmAgent({name: 'instance_override_agent'});

    expect(agent.canonicalModel).toBe(llm);
  });

  it('ignores the override when the agent sets its own model', () => {
    LlmAgent.setDefaultModel('default-test-llm');
    const own = new MockLlm(null);
    const agent = new LlmAgent({name: 'own_model_agent', model: own});

    expect(agent.canonicalModel).toBe(own);
  });

  it('prefers an ancestor model over the override', () => {
    LlmAgent.setDefaultModel('default-test-llm');
    const leaf = new LlmAgent({name: 'leaf_agent'});
    const parentModel = new MockLlm(null);
    new LlmAgent({
      name: 'parent_agent',
      model: parentModel,
      subAgents: [leaf],
    });

    expect(leaf.canonicalModel).toBe(parentModel);
  });

  it('falls through a model-less ancestor to the override', () => {
    LlmAgent.setDefaultModel('default-test-llm');
    const leaf = new LlmAgent({name: 'leaf_agent'});
    new LlmAgent({name: 'parent_agent', subAgents: [leaf]});

    expect(leaf.canonicalModel).toBeInstanceOf(DefaultTestLlm);
  });

  // An agent file is bundled with its own copy of `@google/adk`, so the class
  // the CLI configures is not the class the agent uses. `resetModules` gives a
  // second copy of the module graph to stand in for that one. Re-evaluating
  // that graph costs seconds, so this test needs more than the default budget.
  it(
    'shares the override with a second copy of the module graph',
    async () => {
      const llm = new DefaultTestLlm({model: 'default-test-llm'});
      LlmAgent.setDefaultModel(llm);

      vi.resetModules();
      const {LlmAgent: ReloadedLlmAgent} =
        await import('../../src/agents/llm_agent.js');
      expect(ReloadedLlmAgent).not.toBe(LlmAgent);

      const agent = new ReloadedLlmAgent({name: 'bundled_agent'});
      expect(agent.canonicalModel).toBe(llm);
    },
    MODULE_RELOAD_TIMEOUT_MS,
  );

  it('rejects an empty model name', () => {
    expect(() => LlmAgent.setDefaultModel('')).toThrow(
      'Default model must be a non-empty string.',
    );
  });

  it('throws again after the override is cleared', () => {
    LlmAgent.setDefaultModel('default-test-llm');
    const agent = new LlmAgent({name: 'cleared_agent'});
    expect(agent.canonicalModel).toBeInstanceOf(DefaultTestLlm);

    LlmAgent.setDefaultModel(undefined);

    expect(() => agent.canonicalModel).toThrow(
      'No model found for cleared_agent.',
    );
  });
});

describe('LlmAgent dynamic instructions', () => {
  class DynamicInstructionCapturingLlm extends BaseLlm {
    capturedRequest?: LlmRequest;

    async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.capturedRequest = request;
      yield {content: {role: 'model', parts: [{text: 'done'}]}};
    }

    async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  class DynamicInstructionTool extends BaseTool {
    constructor(private readonly instruction: string) {
      super({
        name: 'dynamic_instruction_tool',
        description: 'contributes an instruction',
      });
    }

    async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
      return {};
    }

    override async processLlmRequest({
      llmRequest,
    }: ToolProcessLlmRequest): Promise<void> {
      appendDynamicInstructions(llmRequest, [this.instruction]);
    }
  }

  it('resolves a tool instruction into the system instruction before the model runs', async () => {
    const llm = new DynamicInstructionCapturingLlm({model: 'gemini-2.5-flash'});
    const agent = new LlmAgent({
      name: 'dynamic_instruction_agent',
      model: llm,
      instruction: 'Base instruction',
      tools: [
        new DynamicInstructionTool('Prefer the artifact named report.pdf.'),
      ],
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_dynamic_1',
      session: createSession({
        id: 'sess_dynamic_1',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
    });

    for await (const _ of agent.runAsync(invocationContext)) {
      // Drain the run so that the request is fully built.
    }

    const request = llm.capturedRequest;
    if (!request) {
      expect.fail('the agent never called the model');
    }
    expect(request.config?.systemInstruction).toContain(
      'Prefer the artifact named report.pdf.',
    );
    expect(request.dynamicInstructions).toEqual([]);
  });
});

describe('LlmAgent default response processors', () => {
  /** Records the code it was asked to run and reports a fixed result. */
  class RecordingCodeExecutor extends BaseCodeExecutor {
    readonly executed: string[] = [];

    async executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
      this.executed.push(params.codeExecutionInput.code);
      return {stdout: 'hello from python', stderr: '', outputFiles: []};
    }
  }

  /**
   * Answers with a code block once, then plainly. The response processor
   * clears the content of a code-block turn so the agent asks again, so a
   * model that always returns code never terminates.
   */
  class CodeBlockLlm extends BaseLlm {
    private calls = 0;

    async *generateContentAsync(
      _request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      this.calls += 1;
      yield this.calls === 1
        ? {
            content: {
              role: 'model',
              parts: [{text: 'Here you go:\n```python\nprint("hi")\n```'}],
            },
          }
        : {content: {role: 'model', parts: [{text: 'All done.'}]}};
    }

    async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  it('runs the code executor on a model response carrying a code block', async () => {
    const codeExecutor = new RecordingCodeExecutor();
    const agent = new LlmAgent({
      name: 'code_agent',
      model: new CodeBlockLlm({model: 'gemini-2.5-flash'}),
      codeExecutor,
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_code',
      session: createSession({
        id: 'sess_code',
        events: [],
        appName: 'test-app',
        userId: 'test-user',
      }),
      agent,
      pluginManager: new PluginManager(),
      artifactService: new ScopedArtifactService(
        new InMemoryArtifactService(),
        'test-app',
        'test-user',
        'sess_code',
      ),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }

    // The executor actually ran, which only happens if the default response
    // pipeline carries the code execution response processor.
    expect(codeExecutor.executed).toEqual(['print("hi")']);

    const texts = events.flatMap((e) =>
      (e.content?.parts ?? []).map((part) => part.text ?? ''),
    );
    expect(texts.some((text) => text.includes('print("hi")'))).toBe(true);
    expect(texts.some((text) => text.includes('hello from python'))).toBe(true);
  });
});

describe('LlmAgent.canonicalTools toolset prefixing', () => {
  class PrefixedToolset extends BaseToolset {
    constructor(
      private readonly tools: BaseTool[],
      prefix: string,
    ) {
      super([], prefix);
    }

    async getTools(): Promise<BaseTool[]> {
      return this.tools;
    }
  }

  it('resolves a toolset through getToolsWithPrefix', async () => {
    const agent = new LlmAgent({
      name: 'prefixing_agent',
      tools: [
        new PrefixedToolset(
          [
            new FunctionTool({
              name: 'search',
              description: 'Search the server',
              execute: async () => 'ok',
            }),
          ],
          'serverA',
        ),
      ],
    });

    const tools = await agent.canonicalTools();

    expect(tools.map((tool) => tool.name)).toEqual(['serverA_search']);
    expect(tools[0]._getDeclaration()?.name).toBe('serverA_search');
  });

  it('gives two toolsets that expose the same tool distinct names', async () => {
    const makeSearch = () =>
      new FunctionTool({
        name: 'search',
        description: 'Search the server',
        execute: async () => 'ok',
      });
    const agent = new LlmAgent({
      name: 'two_server_agent',
      tools: [
        new PrefixedToolset([makeSearch()], 'serverA'),
        new PrefixedToolset([makeSearch()], 'serverB'),
      ],
    });

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-1',
        agent,
        session: createSession({
          id: 'session-1',
          appName: 'test_app',
          userId: 'test_user',
        }),
        pluginManager: new PluginManager([]),
      }),
    });

    for (const tool of await agent.canonicalTools()) {
      await tool.processLlmRequest({toolContext, llmRequest});
    }

    expect(Object.keys(llmRequest.toolsDict)).toEqual([
      'serverA_search',
      'serverB_search',
    ]);
  });
});

describe('LlmAgent set_model_response round trip', () => {
  const OUTPUT_SCHEMA = z4.object({
    name: z4.string(),
    age: z4.number(),
  });

  /** Replays one scripted model turn per call. */
  class ScriptedLlm extends BaseLlm {
    calls = 0;

    constructor(private readonly script: LlmResponse[]) {
      super({model: 'gemini-1.5-pro'});
    }

    async *generateContentAsync(
      _request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void, void> {
      const response = this.script[this.calls];
      this.calls++;
      if (!response) {
        expect.fail(`the agent called the model ${this.calls} times`);
      }
      yield response;
    }

    async connect(): Promise<BaseLlmConnection> {
      return new MockLlmConnection();
    }
  }

  function setModelResponseCall(
    id: string,
    args: Record<string, unknown>,
  ): LlmResponse {
    return {
      content: {
        role: 'model',
        parts: [{functionCall: {id, name: 'set_model_response', args}}],
      },
    };
  }

  async function run(script: LlmResponse[]): Promise<{
    events: Event[];
    llm: ScriptedLlm;
  }> {
    const llm = new ScriptedLlm(script);
    const agent = new LlmAgent({
      name: 'structured_agent',
      model: llm,
      outputSchema: OUTPUT_SCHEMA,
      outputKey: 'structured',
      tools: [
        new FunctionTool({
          name: 'some_tool',
          description: 'A test tool',
          execute: () => 'result',
        }),
      ],
    });
    const session = createSession({
      id: 'sess_smr',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv_smr',
      session,
      agent,
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      events.push(event);
    }
    return {events, llm};
  }

  it('answers with the validated value after a valid call', async () => {
    const {events, llm} = await run([
      setModelResponseCall('call-1', {name: 'Alice', age: 25}),
    ]);

    expect(llm.calls).toBe(1);
    const parts = events.flatMap((event) => event.content?.parts ?? []);
    expect(parts.filter((part) => part.functionCall)).toHaveLength(1);
    expect(parts.filter((part) => part.functionResponse)).toHaveLength(1);

    const finalEvent = events[events.length - 1];
    expect(finalEvent.content?.parts?.[0].text).toBe(
      JSON.stringify({name: 'Alice', age: 25}),
    );
    expect(finalEvent.actions.stateDelta['structured']).toEqual({
      name: 'Alice',
      age: 25,
    });
  });

  it('does not set skipSummarization on the function call event', async () => {
    const {events} = await run([
      setModelResponseCall('call-1', {name: 'Alice', age: 25}),
    ]);

    const callEvent = events.find((event) =>
      (event.content?.parts ?? []).some((part) => part.functionCall),
    );
    if (!callEvent) {
      expect.fail('the agent emitted no function call event');
    }
    expect(callEvent.actions.skipSummarization).toBeUndefined();
    expect(callEvent.content?.parts?.[0].functionCall?.name).toBe(
      'set_model_response',
    );
  });

  it('feeds a validation error back and answers on the retry', async () => {
    const {events, llm} = await run([
      setModelResponseCall('call-1', {name: 'Alice', age: 'twenty five'}),
      setModelResponseCall('call-2', {name: 'Alice', age: 25}),
    ]);

    expect(llm.calls).toBe(2);

    const responses = events
      .flatMap((event) => event.content?.parts ?? [])
      .filter((part) => part.functionResponse);
    expect(responses).toHaveLength(2);
    const firstResponse = responses[0].functionResponse?.response as {
      error?: string;
    };
    expect(firstResponse.error).toContain('Validation Error found');
    expect(firstResponse.error).toContain('age');

    const finalEvent = events[events.length - 1];
    expect(finalEvent.content?.parts?.[0].text).toBe(
      JSON.stringify({name: 'Alice', age: 25}),
    );
    expect(finalEvent.actions.stateDelta['structured']).toEqual({
      name: 'Alice',
      age: 25,
    });
  });

  it('answers when the call arrives alongside another tool call', async () => {
    const {events} = await run([
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'call-1', name: 'some_tool', args: {}}},
            {
              functionCall: {
                id: 'call-2',
                name: 'set_model_response',
                args: {name: 'Alice', age: 25},
              },
            },
          ],
        },
      },
    ]);

    const finalEvent = events[events.length - 1];
    expect(finalEvent.content?.parts?.[0].text).toBe(
      JSON.stringify({name: 'Alice', age: 25}),
    );
  });

  it('yields no final model event for a failed call alone', async () => {
    const {events} = await run([
      setModelResponseCall('call-1', {name: 'Alice', age: 'twenty five'}),
      {content: {role: 'model', parts: [{text: 'giving up'}]}},
    ]);

    const textEvents = events.filter((event) =>
      (event.content?.parts ?? []).some((part) => part.text),
    );
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].content?.parts?.[0].text).toBe('giving up');
  });
});
