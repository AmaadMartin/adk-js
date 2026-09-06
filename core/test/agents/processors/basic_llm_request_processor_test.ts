/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  createSession,
  FunctionTool,
  InvocationContext,
  LiveConnectConfigWithHistory,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  PluginManager,
  RunConfig,
} from '@google/adk';
import {
  Content,
  Blob as GenaiBlob,
  HttpOptions,
  Modality,
  Schema,
  Type,
} from '@google/genai';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {BASIC_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/basic_llm_request_processor.js';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

class TestLlmConnection implements BaseLlmConnection {
  async sendHistory(_history: Content[]): Promise<void> {}
  async sendContent(_content: Content): Promise<void> {}
  async sendRealtime(_blob: GenaiBlob): Promise<void> {}
  async *receive(): AsyncGenerator<LlmResponse, void, void> {}
  async close(): Promise<void> {}
}

class TestLlmModel extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }
  static override readonly supportedModels = ['test-basic-processor-model'];
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {}
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new TestLlmConnection();
  }
}

class MockRootAgent extends BaseAgent {
  constructor(name: string, subAgents: BaseAgent[] = []) {
    super({name, subAgents});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

function createMockInvocationContext(
  agent: BaseAgent,
  runConfig?: RunConfig,
): InvocationContext {
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
    runConfig,
  });
}

function makeLlmRequest(): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

async function runProcessor(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
) {
  for await (const _ of BASIC_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // intentionally empty
  }
}

describe('BasicLlmRequestProcessor', () => {
  beforeAll(() => {
    LLMRegistry.register(TestLlmModel);
  });

  it('should do nothing if agent is not an LlmAgent', async () => {
    const agent = new MockRootAgent('test_agent');
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.model).toBeUndefined();
    expect(llmRequest.config).toBeUndefined();
  });

  it('should set model string from canonicalModel', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.model).toBe('test-basic-processor-model');
  });

  it('should set config from generateContentConfig', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      generateContentConfig: {temperature: 0.5, maxOutputTokens: 100},
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config).toMatchObject({
      temperature: 0.5,
      maxOutputTokens: 100,
    });
  });

  it('should set empty config when generateContentConfig is not set', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config).toEqual({});
  });

  it('should set outputSchema in config when agent has outputSchema', async () => {
    const outputSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        answer: {type: Type.STRING},
      },
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      outputSchema,
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.responseSchema).toBeDefined();
    expect(llmRequest.config?.responseMimeType).toBe('application/json');
  });

  it('should not set outputSchema in config when agent has outputSchema and tools', async () => {
    const outputSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        answer: {type: Type.STRING},
      },
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      outputSchema,
      tools: [
        new FunctionTool({
          name: 'some_tool',
          description: 'A test tool',
          execute: () => 'result',
        }),
      ],
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.responseSchema).toBeUndefined();
    expect(llmRequest.config?.responseMimeType).toBeUndefined();
  });

  describe('outputSchema with tools on a model that supports both', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function runWithOutputSchemaAndTools(
      model: string,
    ): Promise<LlmRequest> {
      const agent = new LlmAgent({
        name: 'test_agent',
        // A model instance is used so that `canonicalModel` resolves without
        // credentials.
        model: new TestLlmModel({model}),
        outputSchema: OUTPUT_SCHEMA,
        tools: [
          new FunctionTool({
            name: 'some_tool',
            description: 'A test tool',
            execute: () => 'result',
          }),
        ],
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      return llmRequest;
    }

    it('should set outputSchema on Vertex AI with a Gemini 2.0+ model', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, 'true');

      const llmRequest = await runWithOutputSchemaAndTools('gemini-2.5-flash');

      expect(llmRequest.config?.responseSchema).toBeDefined();
      expect(llmRequest.config?.responseMimeType).toBe('application/json');
    });

    it('should not set outputSchema on Vertex AI with a pre-2.0 model', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, 'true');

      const llmRequest = await runWithOutputSchemaAndTools('gemini-1.5-pro');

      expect(llmRequest.config?.responseSchema).toBeUndefined();
      expect(llmRequest.config?.responseMimeType).toBeUndefined();
    });

    it('should not set outputSchema outside the Vertex AI variant', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, undefined);

      const llmRequest = await runWithOutputSchemaAndTools('gemini-2.5-flash');

      expect(llmRequest.config?.responseSchema).toBeUndefined();
      expect(llmRequest.config?.responseMimeType).toBeUndefined();
    });
  });

  it('should populate liveConnectConfig from runConfig', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const runConfig: RunConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Puck'}}},
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      enableAffectiveDialog: true,
    };
    const invocationContext = createMockInvocationContext(agent, runConfig);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.liveConnectConfig.responseModalities).toEqual(['AUDIO']);
    expect(llmRequest.liveConnectConfig.speechConfig).toEqual(
      runConfig.speechConfig,
    );
    expect(llmRequest.liveConnectConfig.outputAudioTranscription).toEqual({});
    expect(llmRequest.liveConnectConfig.inputAudioTranscription).toEqual({});
    expect(llmRequest.liveConnectConfig.enableAffectiveDialog).toBe(true);
  });

  it('should not populate liveConnectConfig when runConfig is not set', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.liveConnectConfig.responseModalities).toBeUndefined();
    expect(llmRequest.liveConnectConfig.speechConfig).toBeUndefined();
  });

  it('should yield no events', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent);
    const llmRequest = makeLlmRequest();

    const events = [];
    for await (const event of BASIC_LLM_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });
});

describe('BasicLlmRequestProcessor run config labels', () => {
  it('merges run config labels over the agent labels', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      generateContentConfig: {labels: {team: 'agent-team', tier: 'gold'}},
    });
    const invocationContext = createMockInvocationContext(agent, {
      labels: {team: 'search', cost_center: 'abc-123'},
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.labels).toEqual({
      team: 'search',
      tier: 'gold',
      cost_center: 'abc-123',
    });
  });

  it('does not write run config labels into an empty agent labels object', async () => {
    const agentLabels: Record<string, string> = {};
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      generateContentConfig: {labels: agentLabels},
    });
    const invocationContext = createMockInvocationContext(agent, {
      labels: {team: 'search'},
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(agentLabels).toEqual({});
    expect(llmRequest.config?.labels).toEqual({team: 'search'});
  });

  it('leaves labels unset when the run config has none', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent, {});
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.labels).toBeUndefined();
  });
});

describe('BasicLlmRequestProcessor run config httpOptions', () => {
  it('copies the run config httpOptions when the agent set none', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const runConfigHttpOptions: HttpOptions = {
      timeout: 30_000,
      headers: {'x-request-id': 'req-1'},
    };
    const invocationContext = createMockInvocationContext(agent, {
      httpOptions: runConfigHttpOptions,
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.httpOptions).toEqual(runConfigHttpOptions);

    llmRequest.config!.httpOptions!.headers!['x-request-id'] = 'mutated';
    expect(runConfigHttpOptions.headers).toEqual({'x-request-id': 'req-1'});
  });

  it('copies the run config httpOptions when it carries no headers', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const runConfigHttpOptions: HttpOptions = {timeout: 15_000};
    const invocationContext = createMockInvocationContext(agent, {
      httpOptions: runConfigHttpOptions,
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.httpOptions).toEqual({timeout: 15_000});
    expect(llmRequest.config?.httpOptions).not.toBe(runConfigHttpOptions);
  });

  it('merges over the agent httpOptions with the run config winning', async () => {
    const agentHttpOptions: HttpOptions = {
      baseUrl: 'https://agent.example',
      apiVersion: 'v1',
      timeout: 1_000,
      headers: {'x-agent': 'yes', 'x-request-id': 'agent-id'},
    };
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      generateContentConfig: {httpOptions: agentHttpOptions},
    });
    const invocationContext = createMockInvocationContext(agent, {
      httpOptions: {
        baseUrl: 'https://runconfig.example',
        apiVersion: 'v1beta',
        timeout: 30_000,
        retryOptions: {attempts: 3},
        extraBody: {trace: true},
        headers: {'x-request-id': 'req-1'},
      },
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.httpOptions).toEqual({
      baseUrl: 'https://agent.example',
      apiVersion: 'v1',
      timeout: 30_000,
      retryOptions: {attempts: 3},
      extraBody: {trace: true},
      headers: {'x-agent': 'yes', 'x-request-id': 'req-1'},
    });
    expect(agentHttpOptions).toEqual({
      baseUrl: 'https://agent.example',
      apiVersion: 'v1',
      timeout: 1_000,
      headers: {'x-agent': 'yes', 'x-request-id': 'agent-id'},
    });
  });

  it('keeps the agent httpOptions intact across two invocations', async () => {
    const agentHttpOptions: HttpOptions = {headers: {'x-agent': 'yes'}};
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      generateContentConfig: {httpOptions: agentHttpOptions},
    });
    const runConfig: RunConfig = {
      httpOptions: {headers: {'x-request-id': 'req-1'}},
    };

    const firstRequest = makeLlmRequest();
    await runProcessor(
      createMockInvocationContext(agent, runConfig),
      firstRequest,
    );
    const secondRequest = makeLlmRequest();
    await runProcessor(
      createMockInvocationContext(agent, runConfig),
      secondRequest,
    );

    expect(agentHttpOptions.headers).toEqual({'x-agent': 'yes'});
    expect(secondRequest.config?.httpOptions?.headers).toEqual({
      'x-agent': 'yes',
      'x-request-id': 'req-1',
    });
  });

  it('keeps the agent httpOptions when the run config sets none', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
      generateContentConfig: {httpOptions: {timeout: 1_000}},
    });
    const invocationContext = createMockInvocationContext(agent, {});
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.config?.httpOptions).toEqual({timeout: 1_000});
  });
});

describe('BasicLlmRequestProcessor run config live fields', () => {
  it('forwards the live-connect fields from the run config', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent, {
      explicitVadSignal: true,
      translationConfig: {targetLanguageCode: 'es-ES'},
      avatarConfig: {avatarName: 'ada'},
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.liveConnectConfig.explicitVadSignal).toBe(true);
    expect(llmRequest.liveConnectConfig.translationConfig).toEqual({
      targetLanguageCode: 'es-ES',
    });
    expect(llmRequest.liveConnectConfig.avatarConfig).toEqual({
      avatarName: 'ada',
    });
  });

  it('leaves the live-connect fields unset when the run config omits them', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const invocationContext = createMockInvocationContext(agent, {});
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    const liveConfig: LiveConnectConfigWithHistory =
      llmRequest.liveConnectConfig;
    expect(liveConfig.explicitVadSignal).toBeUndefined();
    expect(liveConfig.translationConfig).toBeUndefined();
    expect(liveConfig.avatarConfig).toBeUndefined();
    expect(liveConfig.sessionResumption).toBeUndefined();
    expect(liveConfig.historyConfig).toBeUndefined();
  });

  it('copies sessionResumption so a later write cannot reach the run config', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const runConfig: RunConfig = {sessionResumption: {transparent: true}};
    const invocationContext = createMockInvocationContext(agent, runConfig);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.liveConnectConfig.sessionResumption).toEqual({
      transparent: true,
    });
    llmRequest.liveConnectConfig.sessionResumption!.handle = 'server-handle';
    expect(runConfig.sessionResumption).toEqual({transparent: true});
  });

  it('copies historyConfig so a later write cannot reach the run config', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test-basic-processor-model',
    });
    const runConfig: RunConfig = {
      historyConfig: {initialHistoryInClientContent: true},
    };
    const invocationContext = createMockInvocationContext(agent, runConfig);
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    const liveConfig: LiveConnectConfigWithHistory =
      llmRequest.liveConnectConfig;
    expect(liveConfig.historyConfig).toEqual({
      initialHistoryInClientContent: true,
    });
    liveConfig.historyConfig!.initialHistoryInClientContent = false;
    expect(runConfig.historyConfig).toEqual({
      initialHistoryInClientContent: true,
    });
  });
});
