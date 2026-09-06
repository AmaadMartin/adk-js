/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  Context,
  createSession,
  Event,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  OUTPUT_SCHEMA_REQUEST_PROCESSOR,
  SET_MODEL_RESPONSE_INSTRUCTION,
} from '../../../src/agents/processors/output_schema_request_processor.js';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

/**
 * A model instance is used rather than a model name so that `canonicalModel`
 * resolves without credentials.
 */
class MockLlm extends BaseLlm {
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {}

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not exercised by these tests');
  }
}

class NonLlmAgent extends BaseAgent {
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createMockInvocationContext(
  agent: BaseAgent,
  liveRequestQueue?: LiveRequestQueue,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    liveRequestQueue,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createAgent(options: {
  model: string;
  withSchema: boolean;
  withTools: boolean;
  mode?: 'single_turn' | 'task';
}): LlmAgent {
  return new LlmAgent({
    name: 'test_agent',
    model: new MockLlm({model: options.model}),
    mode: options.mode,
    outputSchema: options.withSchema ? OUTPUT_SCHEMA : undefined,
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
}

/** Runs the processor and returns the mutated request and the yielded events. */
async function runProcessor(
  agent: BaseAgent,
  liveRequestQueue?: LiveRequestQueue,
): Promise<{llmRequest: LlmRequest; events: Event[]}> {
  const llmRequest: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
  const events: Event[] = [];

  for await (const event of OUTPUT_SCHEMA_REQUEST_PROCESSOR.runAsync(
    createMockInvocationContext(agent, liveRequestQueue),
    llmRequest,
  )) {
    events.push(event);
  }

  return {llmRequest, events};
}

function expectRequestUntouched(llmRequest: LlmRequest): void {
  expect(llmRequest.toolsDict).toEqual({});
  expect(llmRequest.config?.tools).toBeUndefined();
  expect(llmRequest.config?.systemInstruction).toBeUndefined();
}

describe('OutputSchemaRequestProcessor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers the tool and appends the instruction when the model cannot pair a schema with tools', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest, events} = await runProcessor(
      createAgent({
        model: 'gemini-2.5-flash',
        withSchema: true,
        withTools: true,
      }),
    );

    expect(llmRequest.toolsDict['set_model_response']).toBeDefined();
    expect(llmRequest.config?.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({name: 'set_model_response'}),
        ],
      },
    ]);
    expect(llmRequest.config?.systemInstruction).toContain(
      SET_MODEL_RESPONSE_INSTRUCTION,
    );
    expect(events).toEqual([]);
  });

  it('declares the tool with the output schema as its parameters', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest} = await runProcessor(
      createAgent({
        model: 'gemini-2.5-flash',
        withSchema: true,
        withTools: true,
      }),
    );

    expect(
      llmRequest.toolsDict['set_model_response']._getDeclaration()?.parameters,
    ).toEqual(OUTPUT_SCHEMA);
  });

  it('registers the tool on Vertex AI for a pre-2.0 model', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    const {llmRequest} = await runProcessor(
      createAgent({
        model: 'gemini-1.5-pro',
        withSchema: true,
        withTools: true,
      }),
    );

    expect(llmRequest.toolsDict['set_model_response']).toBeDefined();
    expect(llmRequest.config?.systemInstruction).toContain(
      SET_MODEL_RESPONSE_INSTRUCTION,
    );
  });

  it('leaves the request untouched when the model can pair a schema with tools', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    const {llmRequest, events} = await runProcessor(
      createAgent({
        model: 'gemini-2.5-flash',
        withSchema: true,
        withTools: true,
      }),
    );

    expectRequestUntouched(llmRequest);
    expect(events).toEqual([]);
  });

  it('leaves the request untouched when the agent has no tools', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest, events} = await runProcessor(
      createAgent({
        model: 'gemini-2.5-flash',
        withSchema: true,
        withTools: false,
      }),
    );

    expectRequestUntouched(llmRequest);
    expect(events).toEqual([]);
  });

  it('leaves the request untouched when the agent has no output schema', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest, events} = await runProcessor(
      createAgent({
        model: 'gemini-2.5-flash',
        withSchema: false,
        withTools: true,
      }),
    );

    expectRequestUntouched(llmRequest);
    expect(events).toEqual([]);
  });

  it('leaves the request untouched for a task mode agent', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest, events} = await runProcessor(
      createAgent({
        model: 'gemini-2.5-flash',
        withSchema: true,
        withTools: true,
        mode: 'task',
      }),
    );

    expectRequestUntouched(llmRequest);
    expect(events).toEqual([]);
  });

  it('leaves the request untouched on the live path', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const liveRequestQueue = new LiveRequestQueue();

    const {llmRequest, events} = await runProcessor(
      createAgent({
        model: 'gemini-2.5-flash',
        withSchema: true,
        withTools: true,
      }),
      liveRequestQueue,
    );

    expectRequestUntouched(llmRequest);
    expect(events).toEqual([]);
    liveRequestQueue.close();
  });

  it('leaves the request untouched when the agent is not an LlmAgent', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest, events} = await runProcessor(
      new NonLlmAgent({name: 'not_an_llm_agent'}),
    );

    expectRequestUntouched(llmRequest);
    expect(events).toEqual([]);
  });
});

describe('the set_model_response tool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the call arguments as JSON and skips summarization', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const agent = createAgent({
      model: 'gemini-2.5-flash',
      withSchema: true,
      withTools: true,
    });
    const {llmRequest} = await runProcessor(agent);
    const toolContext = new Context({
      invocationContext: createMockInvocationContext(agent),
    });

    const result = await llmRequest.toolsDict['set_model_response'].runAsync({
      args: {answer: 'yes'},
      toolContext,
    });

    expect(result).toBe(JSON.stringify({answer: 'yes'}));
    expect(toolContext.actions.skipSummarization).toBe(true);
  });
});
