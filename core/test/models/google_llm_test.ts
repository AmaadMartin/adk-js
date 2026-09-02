/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Gemini,
  GeminiParams,
  LlmRequest,
  LlmResponse,
  ResourceExhaustedError,
  geminiInitParams,
  version,
} from '@google/adk';
import {
  ApiError,
  Environment,
  GenerateContentConfig,
  GenerateContentResponse,
  GoogleGenAI,
  HttpOptions,
  Modality,
  Part,
  SpeechConfig,
} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

  describe('apiClient configuration', () => {
    /** The httpOptions the most recently built GoogleGenAI client received. */
    function lastHttpOptions(): HttpOptions | undefined {
      const call = vi.mocked(GoogleGenAI).mock.calls.at(-1);
      if (!call) {
        expect.fail('GoogleGenAI was never constructed');
      }
      return call[0].httpOptions;
    }

    /** Defines or removes the `window` global that `isBrowser()` reads. */
    function setWindow(value: object | undefined): void {
      Object.defineProperty(globalThis, 'window', {
        value,
        configurable: true,
        writable: true,
      });
    }

    beforeEach(() => {
      vi.mocked(GoogleGenAI).mockClear();
      delete process.env['GOOGLE_GENAI_API_VERSION'];
    });

    afterEach(() => {
      delete process.env['GOOGLE_GENAI_API_VERSION'];
    });

    it('reads the api version out of a Google base URL', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1alpha',
      });

      expect(llm.apiClient).toBeDefined();
      expect(lastHttpOptions()).toMatchObject({
        baseUrl: 'https://generativelanguage.googleapis.com/',
        apiVersion: 'v1alpha',
      });
    });

    it('preserves the path of a custom base URL', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        baseUrl: 'https://proxy.example.com/gemini/v1alpha',
      });

      expect(llm.apiClient).toBeDefined();
      const httpOptions = lastHttpOptions();
      expect(httpOptions?.baseUrl).toBe(
        'https://proxy.example.com/gemini/v1alpha',
      );
      expect(httpOptions?.apiVersion).toBeUndefined();
    });

    it('leaves the api version to the SDK when nothing is configured', () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      expect(llm.apiClient).toBeDefined();
      const httpOptions = lastHttpOptions();
      expect(httpOptions?.apiVersion).toBeUndefined();
      expect(httpOptions?.baseUrl).toBeUndefined();
    });

    it('sends the configured api version', () => {
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});

      expect(llm.apiClient).toBeDefined();
      expect(lastHttpOptions()?.apiVersion).toBe('v1');
    });

    it('sends the api version from the environment', () => {
      process.env['GOOGLE_GENAI_API_VERSION'] = 'v1';
      const llm = new TestGemini({apiKey: 'test-key'});

      expect(llm.apiClient).toBeDefined();
      expect(lastHttpOptions()?.apiVersion).toBe('v1');
    });

    it('prefers the configured api version over the environment', () => {
      process.env['GOOGLE_GENAI_API_VERSION'] = 'v1beta1';
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});

      expect(llm.apiClient).toBeDefined();
      expect(lastHttpOptions()?.apiVersion).toBe('v1');
    });

    it('does not read the environment in a browser', () => {
      // `isBrowser()` reads this global; a browser has no `process.env`.
      process.env['GOOGLE_GENAI_API_VERSION'] = 'v1';
      setWindow({navigator: {userAgent: 'Mozilla/5.0'}});

      try {
        const llm = new TestGemini({apiKey: 'test-key'});

        expect(llm.apiClient).toBeDefined();
        expect(lastHttpOptions()?.apiVersion).toBeUndefined();
      } finally {
        setWindow(undefined);
      }
    });

    it('prefers the base URL version over the configured one', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        apiVersion: 'v1',
        baseUrl: 'https://generativelanguage.googleapis.com/v1alpha',
      });

      expect(llm.apiClient).toBeDefined();
      expect(lastHttpOptions()).toMatchObject({
        baseUrl: 'https://generativelanguage.googleapis.com/',
        apiVersion: 'v1alpha',
      });
    });

    it('sends the retry options', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        retryOptions: {attempts: 2},
      });

      expect(llm.apiClient).toBeDefined();
      expect(lastHttpOptions()?.retryOptions).toEqual({attempts: 2});
    });

    it('does not retry a live connection', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        retryOptions: {attempts: 2},
      });

      expect(llm.liveApiClient).toBeDefined();
      expect(lastHttpOptions()?.retryOptions).toBeUndefined();
    });

    it('lets clientKwargs override what ADK passes', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        clientKwargs: {apiKey: 'kwargs-key', vertexai: false},
      });

      expect(llm.apiClient).toBeDefined();
      expect(vi.mocked(GoogleGenAI)).toHaveBeenCalledWith(
        expect.objectContaining({apiKey: 'kwargs-key', vertexai: false}),
      );
    });

    it('lets clientKwargs override what ADK passes to a live client', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        clientKwargs: {apiKey: 'kwargs-key'},
      });

      expect(llm.liveApiClient).toBeDefined();
      expect(vi.mocked(GoogleGenAI)).toHaveBeenCalledWith(
        expect.objectContaining({apiKey: 'kwargs-key'}),
      );
    });

    it('uses an injected client and builds none', () => {
      const injected = new GoogleGenAI({apiKey: 'injected-key'});
      vi.mocked(GoogleGenAI).mockClear();
      const llm = new TestGemini({apiKey: 'test-key', client: injected});

      expect(llm.apiClient).toBe(injected);
      expect(llm.liveApiClient).toBe(injected);
      expect(vi.mocked(GoogleGenAI)).not.toHaveBeenCalled();
    });

    it('ignores the configured api version on the live path', () => {
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});

      expect(llm.liveApiVersion).toBe('v1alpha');
      expect(llm.liveApiClient).toBeDefined();
      expect(lastHttpOptions()?.apiVersion).toBe('v1alpha');
    });

    it('uses the base URL version on the live path', () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1alpha',
      });

      expect(llm.liveApiVersion).toBe('v1alpha');
      expect(llm.liveApiClient).toBeDefined();
      expect(lastHttpOptions()).toMatchObject({
        baseUrl: 'https://generativelanguage.googleapis.com/',
        apiVersion: 'v1alpha',
      });
    });

    it('uses the base URL version on the live Vertex path', () => {
      const llm = new TestGemini({
        model: 'gemini-2.5-flash',
        vertexai: true,
        project: 'p',
        location: 'us-central1',
        baseUrl: 'https://aiplatform.googleapis.com/v1',
      });

      expect(llm.liveApiVersion).toBe('v1');
    });
  });

  describe('generateContentAsync request patching', () => {
    /** Runs one non-streaming request and returns the config the SDK saw. */
    async function runAndCaptureConfig(
      llm: Gemini,
      llmRequest: LlmRequest,
    ): Promise<GenerateContentConfig | undefined> {
      const generateContent = vi
        .fn()
        .mockResolvedValue(new GenerateContentResponse());
      llm.apiClient.models.generateContent = generateContent;

      for await (const _ of llm.generateContentAsync(llmRequest, false)) {
        // Drain the generator so the request actually goes out.
      }

      const call = generateContent.mock.calls.at(-1);
      if (!call) {
        expect.fail('generateContent was never called');
      }
      return (call[0] as {config?: GenerateContentConfig}).config;
    }

    function textRequest(config?: GenerateContentConfig): LlmRequest {
      return {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        config,
        liveConnectConfig: {},
        toolsDict: {},
      };
    }

    afterEach(() => {
      delete process.env['GOOGLE_GENAI_API_VERSION'];
    });

    it('adds the tracking headers when the caller sent no http options', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      const config = await runAndCaptureConfig(llm, textRequest());

      expect(config?.httpOptions?.headers?.['x-goog-api-client']).toBe(
        llm.getTrackingHeaders()['x-goog-api-client'],
      );
    });

    it('keeps a caller client alongside the ADK labels', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = textRequest({
        httpOptions: {headers: {'x-goog-api-client': 'my-client/1.0'}},
      });

      const config = await runAndCaptureConfig(llm, request);

      const header = config?.httpOptions?.headers?.['x-goog-api-client'];
      expect(header).toContain('my-client/1.0');
      expect(header).toContain('google-adk/');
    });

    it('patches the api version from the base URL', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1alpha',
      });
      const request = textRequest({
        httpOptions: {headers: {'custom-header': 'custom-value'}},
      });

      const config = await runAndCaptureConfig(llm, request);

      expect(config?.httpOptions?.apiVersion).toBe('v1alpha');
      expect(config?.httpOptions?.headers?.['custom-header']).toBe(
        'custom-value',
      );
    });

    it('patches the configured api version', async () => {
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});

      const config = await runAndCaptureConfig(llm, textRequest({}));

      expect(config?.httpOptions?.apiVersion).toBe('v1');
    });

    it('never overwrites the api version the request carries', async () => {
      const llm = new TestGemini({apiKey: 'test-key', apiVersion: 'v1'});
      const request = textRequest({httpOptions: {apiVersion: 'v2'}});

      const config = await runAndCaptureConfig(llm, request);

      expect(config?.httpOptions?.apiVersion).toBe('v2');
    });

    it('does not patch the api version from the environment', async () => {
      process.env['GOOGLE_GENAI_API_VERSION'] = 'env-version';
      const llm = new TestGemini({apiKey: 'test-key'});

      const config = await runAndCaptureConfig(llm, textRequest({}));

      expect(config?.httpOptions?.apiVersion).toBeUndefined();
    });

    it('appends a user turn before calling the interactions API', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        useInteractionsApi: true,
      });
      const create = vi
        .fn()
        .mockResolvedValue({id: 'i-1', status: 'completed', steps: []});
      // `interactions` is readonly on the client, so the stub is installed
      // with a property descriptor rather than an assignment.
      Object.defineProperty(llm.apiClient, 'interactions', {
        value: {create},
        configurable: true,
      });
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      };

      for await (const _ of llm.generateContentAsync(request, false)) {
        // Drain the generator so the request actually goes out.
      }

      expect(request.contents).toHaveLength(1);
      const call = create.mock.calls.at(-1);
      if (!call) {
        expect.fail('interactions.create was never called');
      }
      expect((call[0] as {input: unknown[]}).input).toHaveLength(1);
    });
  });

  describe('generateContentAsync error handling', () => {
    function apiError(status: number): ApiError {
      return new ApiError({message: `boom ${status}`, status});
    }

    function textRequest(): LlmRequest {
      return {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        liveConnectConfig: {},
        toolsDict: {},
      };
    }

    async function drain(llm: Gemini, stream: boolean): Promise<void> {
      for await (const _ of llm.generateContentAsync(textRequest(), stream)) {
        // Drain the generator so the error surfaces.
      }
    }

    it('enriches a 429 from a non-streaming call', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const generateContent = vi.fn().mockRejectedValue(apiError(429));
      llm.apiClient.models.generateContent = generateContent;

      await expect(drain(llm, false)).rejects.toThrow(ResourceExhaustedError);
      await expect(drain(llm, false)).rejects.toThrow(
        '#error-code-429-resource_exhausted',
      );
      expect(generateContent).toHaveBeenCalledTimes(2);
    });

    it('reports the original status and message on a 429', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      llm.apiClient.models.generateContent = vi
        .fn()
        .mockRejectedValue(apiError(429));

      const error = await drain(llm, false).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ResourceExhaustedError);
      if (!(error instanceof ResourceExhaustedError)) {
        expect.fail('expected a ResourceExhaustedError');
      }
      expect(error.status).toBe(429);
      expect(error.message).toContain('boom 429');
      expect(error.cause).toBeDefined();
    });

    it('enriches a 429 from a streaming call', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const generateContentStream = vi.fn().mockRejectedValue(apiError(429));
      llm.apiClient.models.generateContentStream = generateContentStream;

      await expect(drain(llm, true)).rejects.toThrow(ResourceExhaustedError);
      expect(generateContentStream).toHaveBeenCalledTimes(1);
    });

    it('enriches a 429 raised while the stream is read', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      llm.apiClient.models.generateContentStream = vi.fn().mockResolvedValue(
        (async function* () {
          yield new GenerateContentResponse();
          throw apiError(429);
        })(),
      );

      await expect(drain(llm, true)).rejects.toThrow(ResourceExhaustedError);
    });

    it('rethrows a non-429 from a non-streaming call untouched', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const generateContent = vi.fn().mockRejectedValue(apiError(500));
      llm.apiClient.models.generateContent = generateContent;

      const error = await drain(llm, false).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(ResourceExhaustedError);
      if (!(error instanceof ApiError)) {
        expect.fail('expected an ApiError');
      }
      expect(error.status).toBe(500);
      expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it('rethrows a non-429 from a streaming call untouched', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const generateContentStream = vi.fn().mockRejectedValue(apiError(500));
      llm.apiClient.models.generateContentStream = generateContentStream;

      const error = await drain(llm, true).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(ResourceExhaustedError);
      if (!(error instanceof ApiError)) {
        expect.fail('expected an ApiError');
      }
      expect(error.status).toBe(500);
      expect(generateContentStream).toHaveBeenCalledTimes(1);
    });

    it('rethrows a thrown value that carries no status', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      llm.apiClient.models.generateContent = vi
        .fn()
        .mockRejectedValue(new Error('network down'));

      const error = await drain(llm, false).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(ResourceExhaustedError);
      if (!(error instanceof Error)) {
        expect.fail('expected an Error');
      }
      expect(error.message).toBe('network down');
    });
  });

  describe('preprocessRequest', () => {
    /** Runs one non-streaming request so preprocessing runs on it. */
    async function send(llm: Gemini, llmRequest: LlmRequest): Promise<void> {
      llm.apiClient.models.generateContent = vi
        .fn()
        .mockResolvedValue(new GenerateContentResponse());

      for await (const _ of llm.generateContentAsync(llmRequest, false)) {
        // Drain the generator so preprocessing runs.
      }
    }

    const SYSTEM_INSTRUCTION = 'You are a helpful assistant';

    it('clears the system instruction for a computer-use tool', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request: LlmRequest = {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          tools: [
            {computerUse: {environment: Environment.ENVIRONMENT_BROWSER}},
          ],
        },
        liveConnectConfig: {},
        toolsDict: {},
      };

      await send(llm, request);

      expect(request.config?.systemInstruction).toBeUndefined();
    });

    it('keeps the system instruction for a function tool', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request: LlmRequest = {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          tools: [
            {functionDeclarations: [{name: 'test', description: 'test'}]},
          ],
        },
        liveConnectConfig: {},
        toolsDict: {},
      };

      await send(llm, request);

      expect(request.config?.systemInstruction).toBe(SYSTEM_INSTRUCTION);
    });

    it('keeps the system instruction when there are no tools', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request: LlmRequest = {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        config: {systemInstruction: SYSTEM_INSTRUCTION},
        liveConnectConfig: {},
        toolsDict: {},
      };

      await send(llm, request);

      expect(request.config?.systemInstruction).toBe(SYSTEM_INSTRUCTION);
    });

    it('runs without a config', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request: LlmRequest = {
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
        liveConnectConfig: {},
        toolsDict: {},
      };

      await expect(send(llm, request)).resolves.toBeUndefined();
    });

    it('turns unsupported inline data into text', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request: LlmRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  data: Buffer.from('doc bytes', 'utf8').toString('base64'),
                },
              },
            ],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      };

      await send(llm, request);

      const part = request.contents[0].parts?.[0];
      expect(part?.inlineData).toBeUndefined();
      expect(part?.text).toContain('[Binary artifact: inline-file');
    });

    it('accepts a content that carries no parts', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request: LlmRequest = {
        contents: [{role: 'user'}],
        liveConnectConfig: {},
        toolsDict: {},
      };

      await send(llm, request);

      expect(request.contents[0].parts).toBeUndefined();
    });

    it('leaves supported inline data alone', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const inlineData = {
        mimeType: 'image/png',
        data: Buffer.from('pixels', 'utf8').toString('base64'),
      };
      const request: LlmRequest = {
        contents: [{role: 'user', parts: [{inlineData}]}],
        liveConnectConfig: {},
        toolsDict: {},
      };

      await send(llm, request);

      expect(request.contents[0].parts?.[0].inlineData).toEqual(inlineData);
    });
  });

  describe('connect speech config', () => {
    const MODEL_VOICE: SpeechConfig = {
      voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Puck'}},
    };
    const REQUEST_VOICE: SpeechConfig = {
      voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Zephyr'}},
    };

    function liveRequest(speechConfig?: SpeechConfig): LlmRequest {
      return {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {speechConfig},
        config: {},
        toolsDict: {},
      };
    }

    it('applies the model speech config', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        speechConfig: MODEL_VOICE,
      });
      const request = liveRequest();

      await llm.connect(request);

      expect(request.liveConnectConfig.speechConfig).toEqual(MODEL_VOICE);
    });

    it('keeps the request speech config when the model has none', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = liveRequest(REQUEST_VOICE);

      await llm.connect(request);

      expect(request.liveConnectConfig.speechConfig).toEqual(REQUEST_VOICE);
    });

    it('lets the model speech config win over the request one', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        speechConfig: MODEL_VOICE,
      });
      const request = liveRequest(REQUEST_VOICE);

      await llm.connect(request);

      expect(request.liveConnectConfig.speechConfig).toEqual(MODEL_VOICE);
    });

    it('leaves the speech config unset when neither side has one', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = liveRequest();

      await llm.connect(request);

      expect(request.liveConnectConfig.speechConfig).toBeUndefined();
    });

    it('merges the tracking headers into the live http options', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {
          httpOptions: {headers: {'x-goog-api-client': 'my-client/1.0'}},
        },
        config: {},
        toolsDict: {},
      };

      await llm.connect(request);

      const header =
        request.liveConnectConfig.httpOptions?.headers?.['x-goog-api-client'];
      expect(header).toContain('my-client/1.0');
      expect(header).toContain('google-adk/');
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
});
