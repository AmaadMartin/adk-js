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
    const outputSchema = {
      type: 'object' as const,
      properties: {
        answer: {type: 'string' as const},
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
    const outputSchema = {
      type: 'object' as const,
      properties: {
        answer: {type: 'string' as const},
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

  describe('runConfig.httpOptions', () => {
    it('should merge runConfig httpOptions over the agent httpOptions', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {timeout: 1000, headers: {'Agent-Header': 'agent-val'}},
        },
      });
      const runConfig: RunConfig = {
        httpOptions: {
          timeout: 500,
          headers: {
            'RunConfig-Header': 'run-val',
            'Agent-Header': 'run-val-override',
          },
        },
      };
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );

      expect(llmRequest.config?.httpOptions?.timeout).toBe(500);
      expect(llmRequest.config?.httpOptions?.headers).toEqual({
        'Agent-Header': 'run-val-override',
        'RunConfig-Header': 'run-val',
      });
    });

    it('should merge timeout, extraBody and retryOptions when the runConfig sets no headers', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {timeout: 1000, headers: {'Agent-Header': 'agent-val'}},
        },
      });
      const runConfig: RunConfig = {
        httpOptions: {
          timeout: 500,
          extraBody: {priority: 'high'},
          retryOptions: {attempts: 3},
        },
      };
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );

      expect(llmRequest.config?.httpOptions?.timeout).toBe(500);
      expect(llmRequest.config?.httpOptions?.extraBody).toEqual({
        priority: 'high',
      });
      expect(llmRequest.config?.httpOptions?.retryOptions).toEqual({
        attempts: 3,
      });
      expect(llmRequest.config?.httpOptions?.headers).toEqual({
        'Agent-Header': 'agent-val',
      });
    });

    it('should take the runConfig httpOptions wholesale when the agent has none', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const runConfig: RunConfig = {
        httpOptions: {
          baseUrl: 'https://example.test',
          apiVersion: 'v1',
          headers: {A: 'b'},
        },
      };
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );

      expect(llmRequest.config?.httpOptions).toEqual({
        baseUrl: 'https://example.test',
        apiVersion: 'v1',
        headers: {A: 'b'},
      });
    });

    it('should not let the runConfig baseUrl and apiVersion override the agent httpOptions', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {
            baseUrl: 'https://agent.test',
            apiVersion: 'v1beta',
            timeout: 1000,
          },
        },
      });
      const runConfig: RunConfig = {
        httpOptions: {
          baseUrl: 'https://run.test',
          apiVersion: 'v9',
          timeout: 500,
        },
      };
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );

      expect(llmRequest.config?.httpOptions?.baseUrl).toBe(
        'https://agent.test',
      );
      expect(llmRequest.config?.httpOptions?.apiVersion).toBe('v1beta');
      expect(llmRequest.config?.httpOptions?.timeout).toBe(500);
    });

    it('should leave the agent httpOptions untouched for a later invocation', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {timeout: 1000, headers: {'Agent-Header': 'agent-val'}},
        },
      });
      const firstRunConfig: RunConfig = {
        httpOptions: {timeout: 500, headers: {'RunConfig-Header': 'run-val'}},
      };
      const firstRequest = makeLlmRequest();
      const secondRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, firstRunConfig),
        firstRequest,
      );
      await runProcessor(createMockInvocationContext(agent, {}), secondRequest);

      expect(agent.generateContentConfig?.httpOptions).toEqual({
        timeout: 1000,
        headers: {'Agent-Header': 'agent-val'},
      });
      expect(secondRequest.config?.httpOptions?.timeout).toBe(1000);
      expect(
        secondRequest.config?.httpOptions?.headers?.['RunConfig-Header'],
      ).toBeUndefined();
    });

    it('should not alias the runConfig httpOptions headers into the request', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const runConfig: RunConfig = {
        httpOptions: {headers: {'RunConfig-Header': 'run-val'}},
      };
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );
      const requestHeaders = llmRequest.config?.httpOptions?.headers;
      if (!requestHeaders) {
        expect.fail('expected the merged request to carry headers');
      }
      requestHeaders['Injected'] = 'x';

      expect(runConfig.httpOptions?.headers).toEqual({
        'RunConfig-Header': 'run-val',
      });
    });

    it('should keep the agent httpOptions when the runConfig sets none', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {
          httpOptions: {timeout: 1000, headers: {'Agent-Header': 'agent-val'}},
        },
      });
      const llmRequest = makeLlmRequest();

      await runProcessor(createMockInvocationContext(agent, {}), llmRequest);

      expect(llmRequest.config?.httpOptions).toEqual({
        timeout: 1000,
        headers: {'Agent-Header': 'agent-val'},
      });
    });
  });

  describe('runConfig.labels', () => {
    it('should merge runConfig labels into the request labels', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {labels: {agent_label: 'val1'}},
      });
      const runConfig: RunConfig = {
        labels: {'goog-originating-logical-product-id': 'prod1'},
      };
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );

      expect(llmRequest.config?.labels).toEqual({
        agent_label: 'val1',
        'goog-originating-logical-product-id': 'prod1',
      });
    });

    it('should let a runConfig label win over the agent label on key conflict', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {labels: {shared_label: 'agent-val'}},
      });
      const runConfig: RunConfig = {labels: {shared_label: 'run-val'}};
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );

      expect(llmRequest.config?.labels).toEqual({shared_label: 'run-val'});
    });

    it('should set the labels when the agent has none', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
      });
      const runConfig: RunConfig = {labels: {run_label: 'val'}};
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );

      expect(llmRequest.config?.labels).toEqual({run_label: 'val'});
    });

    it('should not write the runConfig labels into the agent labels', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        model: 'test-basic-processor-model',
        generateContentConfig: {labels: {}},
      });
      const runConfig: RunConfig = {labels: {run_label: 'val'}};
      const llmRequest = makeLlmRequest();

      await runProcessor(
        createMockInvocationContext(agent, runConfig),
        llmRequest,
      );

      expect(llmRequest.config?.labels).toEqual({run_label: 'val'});
      expect(agent.generateContentConfig?.labels).toEqual({});
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
