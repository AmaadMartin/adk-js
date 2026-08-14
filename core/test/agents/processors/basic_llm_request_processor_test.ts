/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BaseLlmConnection,
  LlmRequest,
  LlmResponse,
  RunConfig,
} from '@google/adk';
import {
  BaseAgent,
  BaseLlm,
  createSession,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LLMRegistry,
  PluginManager,
} from '@google/adk';
import type {Content, Blob as GenaiBlob, Schema} from '@google/genai';
import {Modality, Type} from '@google/genai';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {BASIC_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/basic_llm_request_processor.js';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

/** The label key `LlmAgent` writes onto the request config before each call. */
const ADK_AGENT_NAME_LABEL_KEY = 'adk_agent_name';

/** The header key `Gemini` writes onto the request config before each call. */
const TRACKING_HEADER_KEY = 'x-goog-api-client';

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

  describe('affective dialog and proactivity gating', () => {
    const LIVE_RUN_CONFIG: RunConfig = {
      responseModalities: [Modality.AUDIO],
      enableAffectiveDialog: true,
      proactivity: {},
    };

    async function runWithModel(model: string): Promise<LlmRequest> {
      const agent = new LlmAgent({
        name: 'test_agent',
        // A model instance is used so that `canonicalModel` resolves without
        // credentials.
        model: new TestLlmModel({model}),
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, LIVE_RUN_CONFIG),
        llmRequest,
      );

      return llmRequest;
    }

    it('should drop both fields for a Gemini 3.x Live model', async () => {
      const llmRequest = await runWithModel('gemini-3.1-flash-live');

      expect(
        llmRequest.liveConnectConfig.enableAffectiveDialog,
      ).toBeUndefined();
      expect(llmRequest.liveConnectConfig.proactivity).toBeUndefined();
      // The gate is narrow: the other live settings still land.
      expect(llmRequest.liveConnectConfig.responseModalities).toEqual([
        'AUDIO',
      ]);
    });

    it('should keep both fields for a non Gemini 3.x Live model', async () => {
      const llmRequest = await runWithModel('gemini-2.5-flash');

      expect(llmRequest.liveConnectConfig.enableAffectiveDialog).toBe(true);
      expect(llmRequest.liveConnectConfig.proactivity).toEqual({});
    });
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

  describe('request-scoped config copies', () => {
    it('should not write the agent-name label back into the agent config', async () => {
      const agentLabels = {team: 'search'};
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {labels: agentLabels},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);
      llmRequest.config!.labels![ADK_AGENT_NAME_LABEL_KEY] = agent.name;

      expect(agentLabels).toEqual({team: 'search'});
      expect(llmRequest.config?.labels).not.toBe(agentLabels);
    });

    it('should not write tracking headers back into the agent http options', async () => {
      const agentHttpOptions = {
        timeout: 1000,
        headers: {'Agent-Header': 'agent-val'},
      };
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {httpOptions: agentHttpOptions},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);
      llmRequest.config!.httpOptions!.headers = {
        ...llmRequest.config!.httpOptions!.headers,
        [TRACKING_HEADER_KEY]: 'google-adk/test',
      };

      expect(agentHttpOptions.headers).toEqual({'Agent-Header': 'agent-val'});
      expect(agentHttpOptions.timeout).toBe(1000);
      expect(llmRequest.config?.httpOptions).not.toBe(agentHttpOptions);
      expect(llmRequest.config?.httpOptions?.headers).not.toBe(
        agentHttpOptions.headers,
      );
    });

    it("should not leak the first invocation's writes into a second invocation", async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          labels: {team: 'search'},
          httpOptions: {timeout: 1000, headers: {'Agent-Header': 'agent-val'}},
        },
      });
      const firstRequest = makeLlmRequest();
      const secondRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), firstRequest);
      firstRequest.config!.labels![ADK_AGENT_NAME_LABEL_KEY] = agent.name;
      firstRequest.config!.httpOptions!.headers = {
        ...firstRequest.config!.httpOptions!.headers,
        [TRACKING_HEADER_KEY]: 'google-adk/test',
      };
      await runProcessor(createMockInvocationContext(agent), secondRequest);

      expect(secondRequest.config?.labels).toEqual({team: 'search'});
      expect(secondRequest.config?.httpOptions?.headers).toEqual({
        'Agent-Header': 'agent-val',
      });
    });

    it('should not materialize headers when the agent set http options without headers', async () => {
      const agentHttpOptions = {timeout: 1000};
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {httpOptions: agentHttpOptions},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.config?.httpOptions?.headers).toBeUndefined();
      expect(llmRequest.config?.httpOptions?.timeout).toBe(1000);
      expect(llmRequest.config?.httpOptions).not.toBe(agentHttpOptions);
    });

    it('should copy an empty labels object rather than alias it', async () => {
      const agentLabels = {};
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {labels: agentLabels},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.config?.labels).toEqual({});
      expect(llmRequest.config?.labels).not.toBe(agentLabels);
    });

    it('should leave a config without labels or http options untouched', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {temperature: 0.5},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.config?.labels).toBeUndefined();
      expect(llmRequest.config?.httpOptions).toBeUndefined();
      expect(llmRequest.config?.temperature).toBe(0.5);
    });
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
