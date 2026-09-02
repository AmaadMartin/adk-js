/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  Context,
  createSession,
  Event,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  OUTPUT_SCHEMA_REQUEST_PROCESSOR,
  PluginManager,
  SET_MODEL_RESPONSE_TOOL_NAME,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {SET_MODEL_RESPONSE_INSTRUCTION} from '../../../src/agents/processors/output_schema_request_processor.js';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

/** A model instance, so `canonicalModel` resolves without credentials. */
class MockLlm extends BaseLlm {
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {}

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not exercised by these tests');
  }
}

/** A non-LLM agent, to exercise the processor's narrowing guard. */
class PlainAgent extends BaseAgent {
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function someTool(): FunctionTool {
  return new FunctionTool({
    name: 'some_tool',
    description: 'A test tool',
    execute: () => 'result',
  });
}

function createContext(
  agent: BaseAgent,
  liveRequestQueue?: LiveRequestQueue,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    liveRequestQueue,
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager([]),
  });
}

/** The names of the function declarations the request carries. */
function declaredFunctionNames(
  llmRequest: LlmRequest,
): Array<string | undefined> {
  return (llmRequest.config?.tools ?? []).flatMap((tool) =>
    'functionDeclarations' in tool
      ? (tool.functionDeclarations ?? []).map((declaration) => declaration.name)
      : [],
  );
}

/** Runs the processor over a fresh request and reports what it yielded. */
async function run(
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
    createContext(agent, liveRequestQueue),
    llmRequest,
  )) {
    events.push(event);
  }
  return {llmRequest, events};
}

function llmAgent(options: {
  model: string;
  withOutputSchema: boolean;
  withTools: boolean;
  mode?: 'single_turn' | 'task';
}): LlmAgent {
  return new LlmAgent({
    name: 'test_agent',
    model: new MockLlm({model: options.model}),
    outputSchema: options.withOutputSchema ? OUTPUT_SCHEMA : undefined,
    tools: options.withTools ? [someTool()] : [],
    mode: options.mode,
  });
}

describe('OutputSchemaRequestProcessor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('declares the tool and instructs the model when the model cannot pair a schema with tools', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest, events} = await run(
      llmAgent({
        model: 'gemini-2.5-flash',
        withOutputSchema: true,
        withTools: true,
      }),
    );

    expect(events).toEqual([]);
    expect(llmRequest.toolsDict).toHaveProperty('set_model_response');
    expect(llmRequest.config?.systemInstruction).toBe(
      SET_MODEL_RESPONSE_INSTRUCTION,
    );
    expect(declaredFunctionNames(llmRequest)).toEqual(['set_model_response']);
  });

  it('declares the tool with the output schema as its parameters', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest} = await run(
      llmAgent({
        model: 'gemini-2.5-flash',
        withOutputSchema: true,
        withTools: true,
      }),
    );

    const [declaredTool] = llmRequest.config?.tools ?? [];
    if (!declaredTool || !('functionDeclarations' in declaredTool)) {
      expect.fail('no function declarations were added to the request');
    }
    expect(declaredTool.functionDeclarations).toEqual([
      {
        name: SET_MODEL_RESPONSE_TOOL_NAME,
        description: expect.stringContaining('output schema'),
        parameters: OUTPUT_SCHEMA,
      },
    ]);
  });

  it('returns the arguments as JSON and skips summarization when the tool runs', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const agent = llmAgent({
      model: 'gemini-2.5-flash',
      withOutputSchema: true,
      withTools: true,
    });
    const {llmRequest} = await run(agent);
    const tool: BaseTool | undefined =
      llmRequest.toolsDict[SET_MODEL_RESPONSE_TOOL_NAME];
    if (!tool) {
      expect.fail(`${SET_MODEL_RESPONSE_TOOL_NAME} was not registered`);
    }
    const toolContext = new Context({
      invocationContext: createContext(agent),
    });

    const result = await tool.runAsync({args: {answer: '42'}, toolContext});

    expect(result).toBe(JSON.stringify({answer: '42'}));
    expect(toolContext.actions.skipSummarization).toBe(true);
  });

  it('applies the workaround on Vertex AI with a pre-2.0 model', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    const {llmRequest} = await run(
      llmAgent({
        model: 'gemini-1.5-pro',
        withOutputSchema: true,
        withTools: true,
      }),
    );

    expect(llmRequest.toolsDict).toHaveProperty('set_model_response');
    expect(llmRequest.config?.systemInstruction).toBe(
      SET_MODEL_RESPONSE_INSTRUCTION,
    );
  });

  it('leaves the request untouched on Vertex AI with a Gemini 2.0+ model', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');

    const {llmRequest} = await run(
      llmAgent({
        model: 'gemini-2.5-flash',
        withOutputSchema: true,
        withTools: true,
      }),
    );

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config).toBeUndefined();
  });

  it('leaves the request untouched when the agent declares no tools', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest} = await run(
      llmAgent({
        model: 'gemini-2.5-flash',
        withOutputSchema: true,
        withTools: false,
      }),
    );

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config).toBeUndefined();
  });

  it('leaves the request untouched when the agent declares no output schema', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest} = await run(
      llmAgent({
        model: 'gemini-2.5-flash',
        withOutputSchema: false,
        withTools: true,
      }),
    );

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config).toBeUndefined();
  });

  it('leaves a task-mode agent untouched, because finish_task carries its result', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest} = await run(
      llmAgent({
        model: 'gemini-2.5-flash',
        withOutputSchema: true,
        withTools: true,
        mode: 'task',
      }),
    );

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config).toBeUndefined();
  });

  it('leaves the request untouched on the live path', async () => {
    // `LlmAgent.postprocess` reads the tool call back off the merged event. The
    // live path has no such read-back, so the workaround is skipped there.
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const liveRequestQueue = new LiveRequestQueue();

    const {llmRequest, events} = await run(
      llmAgent({
        model: 'gemini-2.5-flash',
        withOutputSchema: true,
        withTools: true,
      }),
      liveRequestQueue,
    );

    expect(events).toEqual([]);
    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config).toBeUndefined();
    liveRequestQueue.close();
  });

  it('leaves the request untouched for an agent that is not an LlmAgent', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const {llmRequest, events} = await run(new PlainAgent({name: 'plain'}));

    expect(events).toEqual([]);
    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config).toBeUndefined();
  });
});
