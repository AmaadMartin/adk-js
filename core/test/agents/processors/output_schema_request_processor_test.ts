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
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  OUTPUT_SCHEMA_INSTRUCTION,
  OUTPUT_SCHEMA_REQUEST_PROCESSOR,
  PluginManager,
  SET_MODEL_RESPONSE_TOOL_NAME,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

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

class MockNonLlmAgent extends BaseAgent {
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createSomeTool(): FunctionTool {
  return new FunctionTool({
    name: 'some_tool',
    description: 'A test tool',
    execute: () => 'result',
  });
}

function createInvocationContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

async function runProcessor(agent: BaseAgent): Promise<LlmRequest> {
  const llmRequest = createLlmRequest();
  for await (const _ of OUTPUT_SCHEMA_REQUEST_PROCESSOR.runAsync(
    createInvocationContext(agent),
    llmRequest,
  )) {
    // The processor yields no events; the loop drains the generator.
  }
  return llmRequest;
}

describe('OutputSchemaRequestProcessor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('adds the tool and the instruction when the model cannot pair a schema with tools', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-2.5-flash'}),
      outputSchema: OUTPUT_SCHEMA,
      tools: [createSomeTool()],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict[SET_MODEL_RESPONSE_TOOL_NAME]).toBeInstanceOf(
      FunctionTool,
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
    expect(llmRequest.config?.systemInstruction).toBe(
      OUTPUT_SCHEMA_INSTRUCTION,
    );
  });

  it('leaves the request untouched when the model can pair a schema with tools', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-2.5-flash'}),
      outputSchema: OUTPUT_SCHEMA,
      tools: [createSomeTool()],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('adds the tool on Vertex AI with a pre-2.0 model', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, 'true');
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-1.5-pro'}),
      outputSchema: OUTPUT_SCHEMA,
      tools: [createSomeTool()],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict).toHaveProperty(SET_MODEL_RESPONSE_TOOL_NAME);
    expect(llmRequest.config?.systemInstruction).toContain(
      SET_MODEL_RESPONSE_TOOL_NAME,
    );
  });

  it('leaves the request untouched when the agent has no tools', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-2.5-flash'}),
      outputSchema: OUTPUT_SCHEMA,
      tools: [],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('leaves the request untouched when the agent has no output schema', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-2.5-flash'}),
      tools: [createSomeTool()],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('leaves the request untouched for an agent in task mode', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-2.5-flash'}),
      mode: 'task',
      outputSchema: OUTPUT_SCHEMA,
      tools: [createSomeTool()],
    });

    const llmRequest = await runProcessor(agent);

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('leaves the request untouched for an agent that is not an LlmAgent', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);

    const llmRequest = await runProcessor(new MockNonLlmAgent({name: 'plain'}));

    expect(llmRequest.toolsDict).toEqual({});
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('returns the arguments as JSON and skips summarization when the tool runs', async () => {
    vi.stubEnv(VERTEX_ENV_VAR, undefined);
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-2.5-flash'}),
      outputSchema: OUTPUT_SCHEMA,
      tools: [createSomeTool()],
    });
    const llmRequest = await runProcessor(agent);
    const tool: BaseTool | undefined =
      llmRequest.toolsDict[SET_MODEL_RESPONSE_TOOL_NAME];
    if (!tool) {
      expect.fail(`${SET_MODEL_RESPONSE_TOOL_NAME} was not registered`);
    }
    const toolContext = new Context({
      invocationContext: createInvocationContext(agent),
    });

    const result = await tool.runAsync({args: {answer: '42'}, toolContext});

    expect(result).toBe(JSON.stringify({answer: '42'}));
    expect(toolContext.actions.skipSummarization).toBe(true);
  });
});
