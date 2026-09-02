/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Gemini,
  geminiInitParams,
  GeminiParams,
  isResourceExhaustedError,
  LlmRequest,
  LlmResponse,
  version,
} from '@google/adk';
import {
  Environment,
  GenerateContentResponse,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  HttpOptions,
  LiveConnectConfig,
  Modality,
  Part,
  SafetySetting,
} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RESOURCE_EXHAUSTED_MITIGATION_MESSAGE} from '../../src/errors/resource_exhausted_error.js';
import {httpOptionsOf} from './http_options_test_utils.js';

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation((options) => ({
      apiClient: {
        clientOptions: {
          httpOptions: options.httpOptions,
        },
      },
      models: {
        generateContentStream: vi.fn(),
        generateContent: vi.fn(),
      },
      interactions: {
        create: vi.fn().mockResolvedValue({}),
      },
      live: {
        connect: vi.fn().mockResolvedValue({
          sendClientContent: vi.fn(),
          sendToolResponse: vi.fn(),
          sendRealtimeInput: vi.fn(),
          close: vi.fn(),
        }),
      },
      vertexai: options.vertexai || false,
    })),
  };
});

class TestGemini extends Gemini {
  constructor(params: GeminiParams) {
    super(params);
  }
  getTrackingHeaders(): Record<string, string> {
    return this.trackingHeaders;
  }
}

const BLOCK_NONE: SafetySetting[] = [
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];
const BLOCK_ONLY_HIGH: SafetySetting[] = [
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
];

/** Reads the live connect config of the most recent connect call. */
function connectConfig(llm: Gemini): LiveConnectConfig {
  const connect = vi.mocked(llm.liveApiClient.live.connect);
  return connect.mock.lastCall![0].config as LiveConnectConfig;
}

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

/** Drains a response stream and returns whatever it threw, or `undefined`. */
async function captureError(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<unknown> {
  try {
    for await (const response of generator) {
      expect(response).toBeDefined();
    }
  } catch (e: unknown) {
    return e;
  }
  return undefined;
}

/**
 * Runs a request to completion against a stub that answers successfully, so a
 * test can assert on the request the model built.
 */
async function runRequest(llm: Gemini, request: LlmRequest): Promise<void> {
  llm.apiClient.models.generateContent = vi
    .fn()
    .mockResolvedValue(new GenerateContentResponse());

  expect(await captureError(llm.generateContentAsync(request, false))).toBe(
    undefined,
  );
}

describe('GoogleLlm', () => {
  const clearEnv = () => {
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
    delete process.env['GOOGLE_GENAI_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
    delete process.env['GOOGLE_GENAI_USE_ENTERPRISE'];
    delete process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'];
    delete process.env['GOOGLE_GENAI_API_VERSION'];
  };

  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('should throw error if apiKey is missing in constructor', () => {
    expect(() => new TestGemini({model: 'gemini-1.5-flash'})).toThrow(
      /API key must be provided/,
    );
  });

  it('should construct with only GOOGLE_API_KEY set', () => {
    // GOOGLE_API_KEY used to be absent from the Gemini-path order entirely, so
    // setting only it failed at construction rather than picking the key up.
    process.env['GOOGLE_API_KEY'] = 'google-api-key';
    expect(() => new TestGemini({model: 'gemini-1.5-flash'})).not.toThrow();
  });

  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is not set', () => {
    const llm = new TestGemini({apiKey: 'test-key'});
    const headers = llm.getTrackingHeaders();
    const expectedValue = `google-adk/${version} gl-typescript/${process.version}`;
    expect(headers['x-goog-api-client']).toEqual(expectedValue);
    expect(headers['user-agent']).toEqual(expectedValue);
  });

  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is set', () => {
    process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'] = 'test-engine';
    const llm = new TestGemini({apiKey: 'test-key'});
    const headers = llm.getTrackingHeaders();
    const expectedValue = `google-adk/${
      version
    }+remote_reasoning_engine gl-typescript/${process.version}`;
    expect(headers['x-goog-api-client']).toEqual(expectedValue);
    expect(headers['user-agent']).toEqual(expectedValue);
  });

  it('should initialize apiClient with merged tracking headers and user headers', () => {
    const userHeaders = {'x-custom-header': 'custom-value'};
    const llm = new TestGemini({apiKey: 'test-key', headers: userHeaders});
    const options = llm.apiClient['apiClient']['clientOptions'][
      'httpOptions'
    ] as HttpOptions;

    expect(options).toBeDefined();
    expect(options.headers!['x-custom-header']).toEqual('custom-value');
    expect(options.headers!['x-goog-api-client']).toContain('google-adk/');
  });

  it('should initialize liveApiClient with only tracking headers and apiVersion', () => {
    const userHeaders = {'x-custom-header': 'should-not-be-here'};
    const llm = new TestGemini({apiKey: 'test-key', headers: userHeaders});
    const liveOptions = llm.liveApiClient['apiClient']['clientOptions'][
      'httpOptions'
    ] as HttpOptions;

    expect(liveOptions).toBeDefined();
    expect(liveOptions.headers).toBeDefined();
    expect(liveOptions.headers!['x-custom-header']).toBeUndefined();
    expect(liveOptions.headers!['x-goog-api-client']).toContain('google-adk/');
    expect(liveOptions.apiVersion).toBeDefined();
  });

  it('should respect configured location for Vertex AI liveApiClient', () => {
    const llm = new TestGemini({
      model: 'projects/p/locations/us-central1/models/gemini-2.5-flash',
      vertexai: true,
      project: 'p',
      location: 'us-central1',
    });

    const spy = vi.mocked(GoogleGenAI);
    spy.mockClear();

    const client = llm.liveApiClient;
    expect(client).toBeDefined();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        vertexai: true,
        project: 'p',
        location: 'us-central1',
      }),
    );
  });

  describe('generateContentAsync streaming thoughtSignature propagation', () => {
    function makeStreamingChunk(
      parts: Record<string, unknown>[],
    ): GenerateContentResponse {
      const response = new GenerateContentResponse();
      response.candidates = [
        {
          content: {
            role: 'model',
            parts: parts as Part[],
          },
        },
      ];
      return response;
    }

    class GeminiWithStreamingChunks extends Gemini {
      private readonly _chunks: GenerateContentResponse[];

      constructor(chunks: GenerateContentResponse[]) {
        super({apiKey: 'test-key'});
        this._chunks = chunks;
      }

      override get apiClient(): GoogleGenAI {
        const chunks = this._chunks;
        return {
          models: {
            generateContentStream: async function () {
              return (async function* () {
                for (const chunk of chunks) {
                  yield chunk;
                }
              })();
            },
          },
          vertexai: false,
        } as unknown as GoogleGenAI;
      }
    }

    it('should propagate thoughtSignature to subsequent function call parts missing it', async () => {
      const signature = 'test-thought-signature-abc123';

      // Chunk 1: function call WITH thoughtSignature
      const chunk1 = makeStreamingChunk([
        {
          functionCall: {name: 'tool_a', args: {q: '1'}},
          thoughtSignature: signature,
        },
      ]);
      // Chunk 2: function call WITHOUT thoughtSignature
      const chunk2 = makeStreamingChunk([
        {functionCall: {name: 'tool_b', args: {q: '2'}}},
      ]);
      // Chunk 3: function call WITHOUT thoughtSignature
      const chunk3 = makeStreamingChunk([
        {functionCall: {name: 'tool_c', args: {q: '3'}}},
      ]);

      const gemini = new GeminiWithStreamingChunks([chunk1, chunk2, chunk3]);
      const request: LlmRequest = {
        contents: [{role: 'user', parts: [{text: 'do stuff'}]}],
        config: {},
        liveConnectConfig: {},
        toolsDict: {},
      };

      const responses = [];
      for await (const response of gemini.generateContentAsync(request, true)) {
        responses.push(response);
      }

      // All function call parts should have the thoughtSignature
      const functionCallResponses = responses.filter((r) =>
        r.content?.parts?.some((p) => p.functionCall),
      );

      expect(functionCallResponses).toHaveLength(3);
      for (const response of functionCallResponses) {
        for (const part of response.content!.parts!) {
          if (part.functionCall) {
            expect(part.thoughtSignature).toBe(signature);
          }
        }
      }
    });

    it('should not set thoughtSignature when no function call has one', async () => {
      // All chunks lack thoughtSignature
      const chunk1 = makeStreamingChunk([
        {functionCall: {name: 'tool_a', args: {q: '1'}}},
      ]);
      const chunk2 = makeStreamingChunk([
        {functionCall: {name: 'tool_b', args: {q: '2'}}},
      ]);

      const gemini = new GeminiWithStreamingChunks([chunk1, chunk2]);
      const request: LlmRequest = {
        contents: [{role: 'user', parts: [{text: 'do stuff'}]}],
        config: {},
        liveConnectConfig: {},
        toolsDict: {},
      };

      const responses = [];
      for await (const response of gemini.generateContentAsync(request, true)) {
        responses.push(response);
      }

      const functionCallResponses = responses.filter((r) =>
        r.content?.parts?.some((p) => p.functionCall),
      );

      expect(functionCallResponses).toHaveLength(2);
      for (const response of functionCallResponses) {
        for (const part of response.content!.parts!) {
          if (part.functionCall) {
            expect(part.thoughtSignature).toBeUndefined();
          }
        }
      }
    });
  });

  describe('geminiInitParams', () => {
    it('should initialize params for Gemini', () => {
      const input = {
        model: 'gemini-1.5-flash',
        apiKey: 'test-key',
      };
      const params = geminiInitParams(input);
      expect(params.model).toBe('gemini-1.5-flash');
      expect(params.apiKey).toBe('test-key');
      expect(params.vertexai).toBe(false);
    });

    it('should use GOOGLE_GENAI_API_KEY env var if apiKey is missing', () => {
      process.env['GOOGLE_GENAI_API_KEY'] = 'env-api-key';
      const input = {
        model: 'gemini-1.5-flash',
      };
      const params = geminiInitParams(input);
      expect(params.apiKey).toBe('env-api-key');
    });

    it('should use GOOGLE_API_KEY env var if apiKey is missing', () => {
      process.env['GOOGLE_API_KEY'] = 'google-api-key';
      const params = geminiInitParams({model: 'gemini-1.5-flash'});
      expect(params.apiKey).toBe('google-api-key');
    });

    it('should prefer GOOGLE_API_KEY over GEMINI_API_KEY', () => {
      // Matches @google/genai and adk-python. The SDK warns "Both ... are set.
      // Using GOOGLE_API_KEY."; adk-js must not then use the other one.
      process.env['GOOGLE_API_KEY'] = 'google-api-key';
      process.env['GEMINI_API_KEY'] = 'gemini-api-key';
      const params = geminiInitParams({model: 'gemini-1.5-flash'});
      expect(params.apiKey).toBe('google-api-key');
    });

    it('should prefer GOOGLE_GENAI_API_KEY over GOOGLE_API_KEY', () => {
      process.env['GOOGLE_GENAI_API_KEY'] = 'genai-api-key';
      process.env['GOOGLE_API_KEY'] = 'google-api-key';
      const params = geminiInitParams({model: 'gemini-1.5-flash'});
      expect(params.apiKey).toBe('genai-api-key');
    });

    it('should return undefined apiKey if missing', () => {
      const input = {
        model: 'gemini-1.5-flash',
      };
      const params = geminiInitParams(input);
      expect(params.apiKey).toBeUndefined();
    });

    it('should initialize params for Vertex AI', () => {
      const input = {
        model: 'gemini-1.5-flash',
        vertexai: true,
        project: 'test-project',
        location: 'us-central1',
      };
      const params = geminiInitParams(input);
      expect(params.vertexai).toBe(true);
      expect(params.project).toBe('test-project');
      expect(params.location).toBe('us-central1');
    });

    it('should use env vars for Vertex AI', () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'env-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'env-location';
      const input = {
        model: 'gemini-1.5-flash',
        vertexai: true,
      };
      const params = geminiInitParams(input);
      expect(params.project).toBe('env-project');
      expect(params.location).toBe('env-location');
    });

    it('should detect Vertex AI from env var', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      process.env['GOOGLE_CLOUD_PROJECT'] = 'env-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'env-location';
      const input = {
        model: 'gemini-1.5-flash',
      };
      const params = geminiInitParams(input);
      expect(params.vertexai).toBe(true);
    });

    it('should detect Vertex AI from GOOGLE_GENAI_USE_ENTERPRISE', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'true';
      process.env['GOOGLE_CLOUD_PROJECT'] = 'env-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'env-location';
      const input = {
        model: 'gemini-1.5-flash',
      };
      const params = geminiInitParams(input);
      expect(params.vertexai).toBe(true);
    });

    it('should not use Vertex AI when GOOGLE_GENAI_USE_ENTERPRISE disables it', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'false';
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      const input = {
        model: 'gemini-1.5-flash',
        apiKey: 'test-key',
      };
      const params = geminiInitParams(input);
      expect(params.vertexai).toBe(false);
    });

    it('should throw error if project is missing for Vertex AI', () => {
      const input = {
        model: 'gemini-1.5-flash',
        vertexai: true,
        location: 'us-central1',
      };
      expect(() => geminiInitParams(input)).toThrow(/VertexAI project/);
    });
  });

  describe('generateContentAsync', () => {
    it('should pass abortSignal to generateContentStream', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const abortController = new AbortController();
      const signal = abortController.signal;

      const mockStreamResult = [
        {candidates: [{content: {parts: [{text: 'response'}]}}]},
      ];

      const generateContentStreamMock = vi
        .fn()
        .mockResolvedValue(mockStreamResult);
      llm.apiClient.models.generateContentStream = generateContentStreamMock;

      const llmRequest = {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        liveConnectConfig: {},
        toolsDict: {},
      };

      const generator = llm.generateContentAsync(llmRequest, true, signal);
      await generator.next();

      expect(generateContentStreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            abortSignal: signal,
          }),
        }),
      );
    });

    it('should throw error when stream is aborted', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const abortController = new AbortController();
      const signal = abortController.signal;

      const generateContentStreamMock = vi
        .fn()
        .mockImplementation(async function* () {
          yield {candidates: [{content: {parts: [{text: 'response1'}]}}]};
          if (signal.aborted) {
            throw new Error('Aborted');
          }
          yield {candidates: [{content: {parts: [{text: 'response2'}]}}]};
        });
      llm.apiClient.models.generateContentStream = generateContentStreamMock;

      const llmRequest = {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        liveConnectConfig: {},
        toolsDict: {},
      };

      const generator = llm.generateContentAsync(llmRequest, true, signal);

      await generator.next();

      abortController.abort();

      await expect(generator.next()).rejects.toThrow('Aborted');
    });
  });

  describe('generateContentAsync streaming', () => {
    /**
     * Creates a Gemini instance with a mock apiClient whose
     * generateContentStream yields the given raw responses as individual
     * streaming chunks.
     */
    function createStreamingGemini(
      rawChunks: Array<{
        candidates?: Array<{
          content?: {role?: string; parts?: Array<Record<string, unknown>>};
          finishReason?: string;
          finishMessage?: string;
        }>;
        usageMetadata?: Record<string, unknown>;
      }>,
    ): Gemini {
      const gemini = new Gemini({apiKey: 'test-key'});

      const chunks = rawChunks.map((raw) => {
        const response = new GenerateContentResponse();
        response.candidates =
          raw.candidates as GenerateContentResponse['candidates'];
        response.usageMetadata =
          raw.usageMetadata as GenerateContentResponse['usageMetadata'];
        return response;
      });

      const mockModels = {
        async generateContentStream(
          _req: unknown,
        ): Promise<AsyncGenerator<GenerateContentResponse>> {
          return (async function* () {
            for (const chunk of chunks) {
              yield chunk;
            }
          })();
        },
        async generateContent(_req: unknown): Promise<GenerateContentResponse> {
          return chunks[0];
        },
      };

      const mockClient = {
        models: mockModels,
        vertexai: false,
      };

      Object.defineProperty(gemini, 'apiClient', {
        get: () => mockClient as unknown as GoogleGenAI,
      });

      return gemini;
    }

    /** Collects all yielded LlmResponses from generateContentAsync. */
    async function collectResponses(
      gemini: Gemini,
      stream: boolean,
    ): Promise<LlmResponse[]> {
      const results: LlmResponse[] = [];
      for await (const response of gemini.generateContentAsync(
        {
          contents: [{role: 'user', parts: [{text: 'hello'}]}],
          liveConnectConfig: {},
          toolsDict: {},
        },
        stream,
      )) {
        results.push(response);
      }
      return results;
    }

    it('should suppress empty finalization chunk after a function call', async () => {
      const gemini = createStreamingGemini([
        // Chunk 1: function call
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'get_weather',
                      args: {location: 'Seattle'},
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
        // Chunk 2: empty text finalization (the bug trigger)
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: ''}],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]);

      const responses = await collectResponses(gemini, true);

      // Only the function call chunk should be yielded; the empty
      // finalization chunk must be suppressed.
      expect(responses).toHaveLength(1);
      expect(responses[0].content?.parts?.[0]?.functionCall).toBeDefined();
      expect(responses[0].content?.parts?.[0]?.functionCall?.name).toBe(
        'get_weather',
      );
    });

    it('should still yield non-empty text chunks after a function call', async () => {
      const gemini = createStreamingGemini([
        // Chunk 1: function call
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'get_weather',
                      args: {location: 'Seattle'},
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
        // Chunk 2: real text response (should NOT be suppressed)
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: 'The weather in Seattle is sunny.'}],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]);

      const responses = await collectResponses(gemini, true);

      // Both the function call and the text response should be yielded.
      // The text accumulation logic marks text chunks as partial and then
      // flushes them, so we expect:
      // 1. The function call chunk
      // 2. The text chunk (marked partial)
      // 3. A flush of accumulated text
      expect(responses.length).toBeGreaterThanOrEqual(2);
      expect(responses[0].content?.parts?.[0]?.functionCall?.name).toBe(
        'get_weather',
      );
      // One of the later responses should contain the text
      const textResponses = responses.filter((r) =>
        r.content?.parts?.some(
          (p) => p.text && p.text === 'The weather in Seattle is sunny.',
        ),
      );
      expect(textResponses.length).toBeGreaterThanOrEqual(1);
    });

    it('should yield empty finalization chunk when no function call preceded it', async () => {
      const gemini = createStreamingGemini([
        // Chunk 1: text response
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: 'Hello there!'}],
              },
            },
          ],
        },
        // Chunk 2: empty text finalization (no preceding function call)
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: ''}],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]);

      const responses = await collectResponses(gemini, true);

      // Without a preceding function call, the empty finalization should
      // still be yielded (along with the flush of accumulated text).
      // We expect at least the text chunk, the flush, and the finalization.
      expect(responses.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('connect', () => {
    it('should connect to live API and return a connection object', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {
          generationConfig: {responseModalities: [Modality.AUDIO]},
        },
        config: {
          systemInstruction: 'You are a helpful assistant.',
          tools: [{googleSearch: {}}],
        },
        toolsDict: {},
      };

      const connection = await llm.connect(request);
      expect(connection).toBeDefined();
      expect(typeof connection.receive).toBe('function');
      expect(typeof connection.sendContent).toBe('function');
      expect(typeof connection.sendRealtime).toBe('function');

      expect(llm.liveApiClient.live.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-2.5-flash',
          config: expect.objectContaining({
            generationConfig: {responseModalities: [Modality.AUDIO]},
            systemInstruction: {
              role: 'system',
              parts: [{text: 'You are a helpful assistant.'}],
            },
            tools: [{googleSearch: {}}],
          }),
        }),
      );
    });

    it('strips sessionResumption.transparent on the Gemini API backend', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        model: 'gemini-2.5-flash',
      });
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {
          sessionResumption: {handle: 'h-1', transparent: true},
        },
        config: {},
        toolsDict: {},
      };

      await llm.connect(request);

      expect(llm.liveApiClient.live.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sessionResumption: {handle: 'h-1'},
          }),
        }),
      );
    });
  });

  describe('liveApiVersion', () => {
    it('uses v1beta1 on the Vertex AI backend', () => {
      const llm = new TestGemini({
        model: 'gemini-2.5-flash',
        vertexai: true,
        project: 'p',
        location: 'us-central1',
      });
      expect(llm.liveApiVersion).toBe('v1beta1');
    });

    it('uses v1alpha on the Gemini API backend', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        model: 'gemini-3.1-flash-live-preview',
      });
      expect(llm.liveApiVersion).toBe('v1alpha');
    });
  });

  describe('supportedModels', () => {
    function matches(model: string): boolean {
      return Gemini.supportedModels.some((pattern) =>
        typeof pattern === 'string'
          ? pattern === model
          : new RegExp(`^${pattern.source}$`).test(model),
      );
    }

    it('matches a Gemma 4 model', () => {
      expect(matches('gemma-4-27b-it')).toBe(true);
    });

    it('matches a model optimizer model', () => {
      expect(matches('model-optimizer-exp-04-09')).toBe(true);
    });

    it('does not match a Gemma 3 model', () => {
      expect(matches('gemma-3-27b-it')).toBe(false);
    });
  });

  describe('api version and base URL', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('takes the API version from a Google base URL', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1alpha',
      });

      const options = httpOptionsOf(llm.apiClient);

      expect(options.baseUrl).toBe(
        'https://generativelanguage.googleapis.com/',
      );
      expect(options.apiVersion).toBe('v1alpha');
    });

    it('leaves the API version unset when nothing is configured', () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      expect(httpOptionsOf(llm.apiClient).apiVersion).toBeUndefined();
    });

    it('takes the API version from the apiVersion field', () => {
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});

      expect(httpOptionsOf(llm.apiClient).apiVersion).toBe('v1');
    });

    it('takes the API version from the environment variable', () => {
      process.env['GOOGLE_GENAI_API_VERSION'] = 'v1';
      const llm = new TestGemini({apiKey: 'test-key'});

      expect(httpOptionsOf(llm.apiClient).apiVersion).toBe('v1');
    });

    it('prefers the apiVersion field over the environment variable', () => {
      process.env['GOOGLE_GENAI_API_VERSION'] = 'v1beta';
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});

      expect(httpOptionsOf(llm.apiClient).apiVersion).toBe('v1');
    });

    it('does not read the environment variable in a browser', () => {
      process.env['GOOGLE_GENAI_API_VERSION'] = 'v1';
      vi.stubGlobal('window', {navigator: {userAgent: 'Mozilla/5.0'}});
      const llm = new TestGemini({apiKey: 'test-key'});

      expect(httpOptionsOf(llm.apiClient).apiVersion).toBeUndefined();
    });

    it('prefers the base URL version over the apiVersion field', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        apiVersion: 'v1',
        baseUrl: 'https://generativelanguage.googleapis.com/v1alpha',
      });

      expect(httpOptionsOf(llm.apiClient).apiVersion).toBe('v1alpha');
    });

    it('keeps a custom base URL path and leaves the version unset', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        baseUrl: 'https://proxy.example.com/gemini/v1alpha',
      });

      const options = httpOptionsOf(llm.apiClient);

      expect(options.baseUrl).toBe('https://proxy.example.com/gemini/v1alpha');
      expect(options.apiVersion).toBeUndefined();
    });

    it('ignores the apiVersion field for the live endpoint', () => {
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});

      expect(llm.liveApiVersion).toBe('v1alpha');
    });

    it('ignores the environment variable for the live endpoint', () => {
      process.env['GOOGLE_GENAI_API_VERSION'] = 'v1';
      const llm = new TestGemini({apiKey: 'test-key'});

      expect(llm.liveApiVersion).toBe('v1alpha');
    });

    it('takes the live API version from a Google base URL', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      });

      expect(llm.liveApiVersion).toBe('v1beta');
      expect(httpOptionsOf(llm.liveApiClient).baseUrl).toBe(
        'https://generativelanguage.googleapis.com/',
      );
    });
  });

  describe('client injection and clientKwargs', () => {
    it('uses the injected client for both endpoints', () => {
      const injected = new GoogleGenAI({apiKey: 'injected'});
      const constructorSpy = vi.mocked(GoogleGenAI);
      constructorSpy.mockClear();

      const llm = new TestGemini({apiKey: 'test-key', client: injected});

      expect(llm.apiClient).toBe(injected);
      expect(llm.liveApiClient).toBe(injected);
      expect(constructorSpy).not.toHaveBeenCalled();
    });

    it('ignores clientKwargs when a client is injected', () => {
      const injected = new GoogleGenAI({apiKey: 'injected'});

      const llm = new TestGemini({
        apiKey: 'test-key',
        client: injected,
        clientKwargs: {location: 'global'},
      });

      expect(llm.apiClient).toBe(injected);
    });

    it('lets clientKwargs override the computed options on both clients', () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const withKwargs = new TestGemini({
        apiKey: 'test-key',
        clientKwargs: {apiKey: 'override', location: 'global'},
      });
      const constructorSpy = vi.mocked(GoogleGenAI);
      constructorSpy.mockClear();

      expect(llm.apiClient).toBeDefined();
      expect(constructorSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({apiKey: 'test-key'}),
      );

      expect(withKwargs.apiClient).toBeDefined();
      expect(constructorSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({apiKey: 'override', location: 'global'}),
      );

      expect(withKwargs.liveApiClient).toBeDefined();
      expect(constructorSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({apiKey: 'override', location: 'global'}),
      );
    });

    it('sets enterprise for a fine-tuned endpoint model on both clients', () => {
      const llm = new TestGemini({
        model: 'projects/p/locations/l/endpoints/e',
        vertexai: true,
        project: 'p',
        location: 'l',
      });
      const constructorSpy = vi.mocked(GoogleGenAI);
      constructorSpy.mockClear();

      expect(llm.apiClient).toBeDefined();
      expect(constructorSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({enterprise: true}),
      );

      expect(llm.liveApiClient).toBeDefined();
      expect(constructorSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({enterprise: true}),
      );
    });

    it('does not set enterprise for a plain model name', () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const constructorSpy = vi.mocked(GoogleGenAI);
      constructorSpy.mockClear();

      expect(llm.apiClient).toBeDefined();
      expect(constructorSpy).toHaveBeenLastCalledWith(
        expect.not.objectContaining({enterprise: true}),
      );
    });
  });

  describe('retryOptions', () => {
    it('applies to the non-live client only', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        retryOptions: {attempts: 3},
      });

      expect(httpOptionsOf(llm.apiClient).retryOptions).toEqual({attempts: 3});
      expect(httpOptionsOf(llm.liveApiClient).retryOptions).toBeUndefined();
    });
  });

  describe('resource exhausted errors', () => {
    function quotaError(): Error {
      return Object.assign(new Error('Quota exceeded for requests'), {
        status: 429,
      });
    }

    it.each([false, true])(
      'wraps a 429 rejection with the mitigation guide (stream: %s)',
      async (stream) => {
        const llm = new TestGemini({apiKey: 'test-key'});
        const rejection = quotaError();
        llm.apiClient.models.generateContent = vi
          .fn()
          .mockRejectedValue(rejection);
        llm.apiClient.models.generateContentStream = vi
          .fn()
          .mockRejectedValue(rejection);

        const error = await captureError(
          llm.generateContentAsync(makeRequest(), stream),
        );

        if (!isResourceExhaustedError(error)) {
          expect.fail('expected a ResourceExhaustedError');
        }
        expect(error.message).toContain(RESOURCE_EXHAUSTED_MITIGATION_MESSAGE);
        expect(error.message).toContain('Quota exceeded for requests');
        expect(error.status).toBe(429);
        expect(error.cause).toBe(rejection);
      },
    );

    it.each([false, true])(
      'rethrows a non-429 rejection unchanged (stream: %s)',
      async (stream) => {
        const llm = new TestGemini({apiKey: 'test-key'});
        const rejection = Object.assign(new Error('Server error'), {
          status: 500,
        });
        llm.apiClient.models.generateContent = vi
          .fn()
          .mockRejectedValue(rejection);
        llm.apiClient.models.generateContentStream = vi
          .fn()
          .mockRejectedValue(rejection);

        const error = await captureError(
          llm.generateContentAsync(makeRequest(), stream),
        );

        expect(error).toBe(rejection);
        expect(isResourceExhaustedError(error)).toBe(false);
      },
    );

    it('wraps a 429 raised part way through a stream', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const rejection = quotaError();
      llm.apiClient.models.generateContentStream = vi
        .fn()
        .mockImplementation(async function* () {
          yield {candidates: [{content: {parts: [{text: 'partial'}]}}]};
          throw rejection;
        });

      const error = await captureError(
        llm.generateContentAsync(makeRequest(), true),
      );

      expect(isResourceExhaustedError(error)).toBe(true);
    });
  });

  describe('connect speech config', () => {
    it('uses the model speech config when the request has none', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        speechConfig: {languageCode: 'en-US'},
      });

      await llm.connect(makeRequest({config: {}}));

      expect(connectConfig(llm).speechConfig).toEqual({languageCode: 'en-US'});
    });

    it('keeps the request speech config when the model has none', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(
        makeRequest({
          config: {},
          liveConnectConfig: {speechConfig: {languageCode: 'fr-FR'}},
        }),
      );

      expect(connectConfig(llm).speechConfig).toEqual({languageCode: 'fr-FR'});
    });

    it('lets the model speech config override the request', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        speechConfig: {languageCode: 'en-US'},
      });

      await llm.connect(
        makeRequest({
          config: {},
          liveConnectConfig: {speechConfig: {languageCode: 'fr-FR'}},
        }),
      );

      expect(connectConfig(llm).speechConfig).toEqual({languageCode: 'en-US'});
    });

    it('leaves the speech config unset when neither side has one', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(makeRequest({config: {}}));

      expect(connectConfig(llm).speechConfig).toBeUndefined();
    });
  });

  describe('connect config forwarding', () => {
    it('merges the tracking headers and live API version into the request http options', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      });
      const request = makeRequest({
        config: {},
        liveConnectConfig: {httpOptions: {}},
      });

      await llm.connect(request);

      const httpOptions = request.liveConnectConfig.httpOptions;
      expect(httpOptions?.headers).toMatchObject(llm.getTrackingHeaders());
      expect(httpOptions?.apiVersion).toBe('v1beta');
    });

    it('sends an empty system instruction part when none is set', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(makeRequest({config: {}}));

      expect(connectConfig(llm).systemInstruction).toEqual({
        role: 'system',
        parts: [{text: undefined}],
      });
    });

    it('forwards the thinking config', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(
        makeRequest({config: {thinkingConfig: {includeThoughts: true}}}),
      );

      expect(connectConfig(llm).thinkingConfig).toEqual({
        includeThoughts: true,
      });
    });

    it('leaves the thinking config unset when the request has none', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(makeRequest({config: {}}));

      expect(connectConfig(llm).thinkingConfig).toBeUndefined();
    });

    it('forwards the safety settings', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(makeRequest({config: {safetySettings: BLOCK_NONE}}));

      expect(connectConfig(llm).safetySettings).toEqual(BLOCK_NONE);
    });

    it('keeps safety settings already on the live config', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(
        makeRequest({
          config: {safetySettings: BLOCK_NONE},
          liveConnectConfig: {safetySettings: BLOCK_ONLY_HIGH},
        }),
      );

      expect(connectConfig(llm).safetySettings).toEqual(BLOCK_ONLY_HIGH);
    });

    it('keeps an explicitly empty live safety settings list', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(
        makeRequest({
          config: {safetySettings: BLOCK_NONE},
          liveConnectConfig: {safetySettings: []},
        }),
      );

      expect(connectConfig(llm).safetySettings).toEqual([]);
    });

    it('leaves the safety settings unset when neither side has any', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(makeRequest({config: {}}));

      expect(connectConfig(llm).safetySettings).toBeUndefined();
    });
  });

  describe('preprocessRequest', () => {
    function docxRequest(): LlmRequest {
      return makeRequest({
        contents: [
          {
            role: 'user',
            parts: [
              {text: 'look at this'},
              {
                inlineData: {
                  mimeType:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  data: Buffer.from('binary').toString('base64'),
                },
              },
            ],
          },
        ],
        config: {},
      });
    }

    it('converts unsupported inline data into a text part', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = docxRequest();

      await runRequest(llm, request);

      const parts = request.contents[0].parts;
      expect(parts?.[0]).toEqual({text: 'look at this'});
      expect(parts?.[1].inlineData).toBeUndefined();
      expect(parts?.[1].text).toContain('inline-file');
    });

    it('leaves a supported inline part alone', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const inlineData = {
        mimeType: 'image/png',
        data: Buffer.from('png').toString('base64'),
      };
      const request = makeRequest({
        contents: [{role: 'user', parts: [{inlineData}]}],
        config: {},
      });

      await runRequest(llm, request);

      expect(request.contents[0].parts?.[0].inlineData).toEqual(inlineData);
    });

    it('leaves a content that has no parts alone', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = makeRequest({
        contents: [{role: 'user'}],
        config: {},
      });

      await runRequest(llm, request);

      expect(request.contents[0].parts).toBeUndefined();
    });

    it('sanitizes the request before the interactions API call', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        useInteractionsApi: true,
      });
      const request = docxRequest();

      await runRequest(llm, request);

      expect(request.contents[0].parts?.[1].inlineData).toBeUndefined();
      expect(llm.apiClient.interactions.create).toHaveBeenCalled();
    });

    it('clears the system instruction when a computer use tool is present', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = makeRequest({
        config: {
          systemInstruction: 'be careful',
          tools: [
            {computerUse: {environment: Environment.ENVIRONMENT_BROWSER}},
          ],
        },
      });

      await runRequest(llm, request);

      expect(request.config?.systemInstruction).toBeUndefined();
    });

    it('keeps the system instruction when no tool uses computer use', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = makeRequest({
        config: {systemInstruction: 'be careful', tools: [{googleSearch: {}}]},
      });

      await runRequest(llm, request);

      expect(request.config?.systemInstruction).toBe('be careful');
    });

    it('keeps the system instruction when the request has no tools', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = makeRequest({config: {systemInstruction: 'be careful'}});

      await runRequest(llm, request);

      expect(request.config?.systemInstruction).toBe('be careful');
    });

    it('survives a request with no config', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = makeRequest();
      expect(request.config).toBeUndefined();

      await runRequest(llm, request);

      expect(request.config?.systemInstruction).toBeUndefined();
    });
  });

  describe('per-request http options', () => {
    it('creates the http options and merges the tracking headers', async () => {
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});
      const request = makeRequest({config: {}});

      await runRequest(llm, request);

      expect(request.config?.httpOptions?.headers).toMatchObject(
        llm.getTrackingHeaders(),
      );
      expect(request.config?.httpOptions?.apiVersion).toBe('v1');
    });

    it('keeps an API version the request already set', async () => {
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});
      const request = makeRequest({
        config: {httpOptions: {apiVersion: 'v1beta'}},
      });

      await runRequest(llm, request);

      expect(request.config?.httpOptions?.apiVersion).toBe('v1beta');
    });

    it('does not read the environment variable on the request path', async () => {
      process.env['GOOGLE_GENAI_API_VERSION'] = 'v1';
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = makeRequest({config: {}});

      await runRequest(llm, request);

      expect(request.config?.httpOptions?.apiVersion).toBeUndefined();
    });
  });
});
