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
  HarmCategory,
  HttpOptions,
  MediaResolution,
  Modality,
  SafetySetting,
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

/**
 * Builds a request the way `LlmAgent` does when the run config carries HTTP
 * options: seeded onto the config before the processors run.
 */
function seedRequestWithHttpOptions(httpOptions: HttpOptions): LlmRequest {
  const llmRequest = makeLlmRequest();
  llmRequest.config = {httpOptions};
  return llmRequest;
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

  describe('run config httpOptions', () => {
    it('wins on timeout and on a conflicting header key', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {
            timeout: 1000,
            headers: {'Agent-Header': 'agent', Shared: 'agent'},
          },
        },
      });
      const llmRequest = seedRequestWithHttpOptions({
        timeout: 5000,
        headers: {Shared: 'run', 'RunConfig-Header': 'run'},
      });

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.config?.httpOptions).toEqual({
        timeout: 5000,
        headers: {
          'Agent-Header': 'agent',
          Shared: 'run',
          'RunConfig-Header': 'run',
        },
      });
    });

    it('merges timeout and extraBody while the agent header survives', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {timeout: 1000, headers: {'Agent-Header': 'agent'}},
        },
      });
      const llmRequest = seedRequestWithHttpOptions({
        timeout: 5000,
        extraBody: {labels: 'run'},
      });

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.config?.httpOptions).toEqual({
        timeout: 5000,
        headers: {'Agent-Header': 'agent'},
        extraBody: {labels: 'run'},
      });
    });

    it('replaces the agent retryOptions and never merges baseUrl', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {
            baseUrl: 'https://agent.example.com',
            apiVersion: 'v1',
            retryOptions: {attempts: 2},
          },
        },
      });
      const runConfigRetryOptions = {attempts: 7};
      const llmRequest = seedRequestWithHttpOptions({
        baseUrl: 'https://run.example.com',
        apiVersion: 'v1beta',
        retryOptions: runConfigRetryOptions,
      });

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.config?.httpOptions).toEqual({
        baseUrl: 'https://agent.example.com',
        apiVersion: 'v1',
        retryOptions: {attempts: 7},
      });
      expect(llmRequest.config?.httpOptions?.retryOptions).not.toBe(
        runConfigRetryOptions,
      );
    });

    it('adopts the run config options when the agent set none', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {temperature: 0.5},
      });
      const llmRequest = seedRequestWithHttpOptions({
        baseUrl: 'https://run.example.com',
        apiVersion: 'v1beta',
        timeout: 5000,
      });

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.config?.httpOptions).toEqual({
        baseUrl: 'https://run.example.com',
        apiVersion: 'v1beta',
        timeout: 5000,
      });
    });

    it('does not reach the agent', async () => {
      const agentHttpOptions = {
        timeout: 1000,
        headers: {'Agent-Header': 'agent'},
      };
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {httpOptions: agentHttpOptions},
      });
      const llmRequest = seedRequestWithHttpOptions({
        timeout: 5000,
        headers: {'RunConfig-Header': 'run'},
      });

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(agentHttpOptions).toEqual({
        timeout: 1000,
        headers: {'Agent-Header': 'agent'},
      });
    });

    it('leaves the agent options intact for a second invocation', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {timeout: 1000, headers: {'Agent-Header': 'agent'}},
        },
      });
      const invocationContext = createMockInvocationContext(agent);

      await runProcessor(
        invocationContext,
        seedRequestWithHttpOptions({
          timeout: 5000,
          headers: {'RunConfig-Header': 'run'},
        }),
      );
      const secondRequest = makeLlmRequest();
      await runProcessor(invocationContext, secondRequest);

      expect(secondRequest.config?.httpOptions?.timeout).toBe(1000);
      expect(
        secondRequest.config?.httpOptions?.headers?.['RunConfig-Header'],
      ).toBeUndefined();
    });

    it('is not aliased into the request', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const runConfigHttpOptions = {headers: {'RunConfig-Header': 'run'}};
      const llmRequest = seedRequestWithHttpOptions(runConfigHttpOptions);

      await runProcessor(createMockInvocationContext(agent), llmRequest);
      const requestHeaders = llmRequest.config?.httpOptions?.headers;
      if (!requestHeaders) {
        expect.fail('the processor dropped the run config http options');
      }
      requestHeaders['Written-After-The-Run'] = 'yes';

      expect(runConfigHttpOptions.headers).toEqual({
        'RunConfig-Header': 'run',
      });
    });
  });

  describe('run config labels', () => {
    it('merge over the agent labels', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {labels: {shared: 'agent', kept: 'agent'}},
      });
      const invocationContext = createMockInvocationContext(agent, {
        labels: {shared: 'run', added: 'run'},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(invocationContext, llmRequest);

      expect(llmRequest.config?.labels).toEqual({
        shared: 'run',
        kept: 'agent',
        added: 'run',
      });
    });

    it('do not reach an empty agent labels object', async () => {
      const agentLabels: Record<string, string> = {};
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {labels: agentLabels},
      });
      const invocationContext = createMockInvocationContext(agent, {
        labels: {added: 'run'},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(invocationContext, llmRequest);

      expect(llmRequest.config?.labels).toEqual({added: 'run'});
      expect(agentLabels).toEqual({});
    });
  });

  describe('request-scoped config copy', () => {
    it('keeps a safety setting pushed after the run off the agent', async () => {
      const agentSafetySettings: SafetySetting[] = [
        {category: HarmCategory.HARM_CATEGORY_HARASSMENT},
      ];
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {safetySettings: agentSafetySettings},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);
      llmRequest.config?.safetySettings?.push({
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      });

      expect(agentSafetySettings).toHaveLength(1);
    });

    it('yields an empty config for an agent that has no generation config', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      // `LlmAgent` defaults the field to `{}`. LLM flows also drive agents
      // defined outside the package that leave it unset.
      agent.generateContentConfig = undefined;
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.config).toEqual({});
      expect(llmRequest.liveConnectConfig.temperature).toBeUndefined();
    });

    it('does not accumulate safety settings across invocations', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          safetySettings: [{category: HarmCategory.HARM_CATEGORY_HARASSMENT}],
        },
      });
      const invocationContext = createMockInvocationContext(agent);

      const firstRequest = makeLlmRequest();
      await runProcessor(invocationContext, firstRequest);
      firstRequest.config?.safetySettings?.push({
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      });
      const secondRequest = makeLlmRequest();
      await runProcessor(invocationContext, secondRequest);

      expect(secondRequest.config?.safetySettings).toHaveLength(1);
    });
  });

  describe('agent sampling settings on liveConnectConfig', () => {
    const SAMPLING_CONFIG = {
      temperature: 0.25,
      topP: 0.8,
      topK: 40,
      maxOutputTokens: 256,
      seed: 7,
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
    };

    it('copies all six fields', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: SAMPLING_CONFIG,
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.liveConnectConfig).toMatchObject(SAMPLING_CONFIG);
    });

    it('does not overwrite a field already set on the live config', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: SAMPLING_CONFIG,
      });
      const llmRequest = makeLlmRequest();
      llmRequest.liveConnectConfig.temperature = 0.9;

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.liveConnectConfig.temperature).toBe(0.9);
      expect(llmRequest.liveConnectConfig.topP).toBe(0.8);
    });

    it('leaves the fields unset without an agent config', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent), llmRequest);

      expect(llmRequest.liveConnectConfig.temperature).toBeUndefined();
      expect(llmRequest.liveConnectConfig.topP).toBeUndefined();
      expect(llmRequest.liveConnectConfig.topK).toBeUndefined();
      expect(llmRequest.liveConnectConfig.maxOutputTokens).toBeUndefined();
      expect(llmRequest.liveConnectConfig.seed).toBeUndefined();
      expect(llmRequest.liveConnectConfig.mediaResolution).toBeUndefined();
    });
  });

  describe('live sub-configs from the run config', () => {
    it('does not alias the run config sessionResumption', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const sessionResumption = {handle: 'original', transparent: true};
      const invocationContext = createMockInvocationContext(agent, {
        sessionResumption,
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(invocationContext, llmRequest);
      const copied = llmRequest.liveConnectConfig.sessionResumption;
      if (!copied) {
        expect.fail('the processor dropped sessionResumption');
      }
      copied.handle = 'server-issued';

      expect(sessionResumption.handle).toBe('original');
    });

    it('leaves an absent sessionResumption undefined', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const invocationContext = createMockInvocationContext(agent, {});
      const llmRequest = makeLlmRequest();

      await runProcessor(invocationContext, llmRequest);

      expect(llmRequest.liveConnectConfig.sessionResumption).toBeUndefined();
    });

    it('forwards translationConfig', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const translationConfig = {targetLanguageCode: 'es'};
      const invocationContext = createMockInvocationContext(agent, {
        translationConfig,
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(invocationContext, llmRequest);

      expect(llmRequest.liveConnectConfig.translationConfig).toEqual(
        translationConfig,
      );
    });

    it('leaves an absent translationConfig undefined', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const invocationContext = createMockInvocationContext(agent, {});
      const llmRequest = makeLlmRequest();

      await runProcessor(invocationContext, llmRequest);

      expect(llmRequest.liveConnectConfig.translationConfig).toBeUndefined();
    });

    it('forwards explicitVadSignal, contextWindowCompression and avatarConfig', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const contextWindowCompression = {triggerTokens: '1000'};
      const avatarConfig = {avatarName: 'avatar-1'};
      const invocationContext = createMockInvocationContext(agent, {
        explicitVadSignal: true,
        contextWindowCompression,
        avatarConfig,
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(invocationContext, llmRequest);

      expect(llmRequest.liveConnectConfig.explicitVadSignal).toBe(true);
      expect(llmRequest.liveConnectConfig.contextWindowCompression).toEqual(
        contextWindowCompression,
      );
      expect(llmRequest.liveConnectConfig.avatarConfig).toEqual(avatarConfig);
    });
  });

  describe('Gemini 3.x live gating', () => {
    async function runWithLiveModel(model: string): Promise<LlmRequest> {
      const agent = new LlmAgent({
        name: 'test_agent',
        // A model instance is used so that `canonicalModel` resolves without
        // credentials.
        model: new TestLlmModel({model}),
      });
      const invocationContext = createMockInvocationContext(agent, {
        enableAffectiveDialog: true,
        proactivity: {proactiveAudio: true},
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(invocationContext, llmRequest);

      return llmRequest;
    }

    it('clears both fields for a Gemini 3.x live model', async () => {
      const llmRequest = await runWithLiveModel(
        'gemini-3.5-flash-lite-live-preview',
      );

      expect(
        llmRequest.liveConnectConfig.enableAffectiveDialog,
      ).toBeUndefined();
      expect(llmRequest.liveConnectConfig.proactivity).toBeUndefined();
    });

    it('keeps both fields for a Gemini 2.x live model', async () => {
      const llmRequest = await runWithLiveModel('gemini-2.5-flash-live');

      expect(llmRequest.liveConnectConfig.enableAffectiveDialog).toBe(true);
      expect(llmRequest.liveConnectConfig.proactivity).toEqual({
        proactiveAudio: true,
      });
    });

    it('keeps both fields for a Gemini 3.5 live translate model', async () => {
      const llmRequest = await runWithLiveModel(
        'gemini-3.5-live-translate-preview',
      );

      expect(llmRequest.liveConnectConfig.enableAffectiveDialog).toBe(true);
      expect(llmRequest.liveConnectConfig.proactivity).toEqual({
        proactiveAudio: true,
      });
    });

    it('keeps both fields for a non-live Gemini 3.x model', async () => {
      const llmRequest = await runWithLiveModel('gemini-3.5-flash');

      expect(llmRequest.liveConnectConfig.enableAffectiveDialog).toBe(true);
      expect(llmRequest.liveConnectConfig.proactivity).toEqual({
        proactiveAudio: true,
      });
    });
  });
});
