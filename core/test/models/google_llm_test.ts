/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Gemini,
  geminiInitParams,
  GeminiParams,
  LlmRequest,
  LlmResponse,
  Logger,
  LogLevel,
  setLogLevel,
  version,
} from '@google/adk';
import {
  Blob,
  FileData,
  FinishReason,
  GenerateContentResponse,
  GoogleGenAI,
  HttpOptions,
  Modality,
  Part,
} from '@google/genai';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {logger, resetLogger} from '../../src/utils/logger.js';

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

function createRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    config: {},
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function createResponse(): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [
    {
      content: {role: 'model', parts: [{text: 'hi'}]},
      finishReason: FinishReason.STOP,
    },
  ];
  return response;
}

/** Makes the mocked SDK client answer a non-streaming call. */
function mockGenerateContent(llm: Gemini) {
  const generateContent = vi.mocked(llm.apiClient.models.generateContent);
  generateContent.mockResolvedValue(createResponse());
  return generateContent;
}

/** Makes the mocked SDK client answer a streaming call with one chunk. */
function mockGenerateContentStream(llm: Gemini) {
  const generateContentStream = vi.mocked(
    llm.apiClient.models.generateContentStream,
  );
  generateContentStream.mockImplementation(async () =>
    (async function* () {
      yield createResponse();
    })(),
  );
  return generateContentStream;
}

async function collectFrom(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
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

    it('rejects sessionResumption.transparent on the Gemini API backend', async () => {
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

      await expect(llm.connect(request)).rejects.toThrow(
        'Transparent session resumption is only supported for Vertex AI backend. Please use Vertex AI backend.',
      );
      expect(llm.liveApiClient.live.connect).not.toHaveBeenCalled();
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

  describe('model name guard', () => {
    it('rejects a blank model on generateContentAsync', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await expect(
        collectFrom(llm.generateContentAsync(createRequest({model: '  '}))),
      ).rejects.toThrow('Gemini requests require a model name.');
    });

    it('rejects a blank model on connect', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await expect(llm.connect(createRequest({model: ''}))).rejects.toThrow(
        'Live Gemini requests require a model name.',
      );
    });

    it('falls back to the instance model when the request has none', async () => {
      const llm = new TestGemini({
        apiKey: 'test-key',
        model: 'gemini-2.5-flash',
      });
      const generateContent = mockGenerateContent(llm);

      await collectFrom(llm.generateContentAsync(createRequest({})));

      expect(generateContent).toHaveBeenCalledWith(
        expect.objectContaining({model: 'gemini-2.5-flash'}),
      );
    });
  });

  describe('transparent session resumption', () => {
    it('rejects the request on the Gemini API backend', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = createRequest({
        liveConnectConfig: {
          sessionResumption: {handle: 'h-1', transparent: true},
        },
      });

      await expect(llm.connect(request)).rejects.toThrow(
        'Transparent session resumption is only supported for Vertex AI backend. Please use Vertex AI backend.',
      );
    });

    it('passes the flag through on the Vertex AI backend', async () => {
      const llm = new TestGemini({
        model: 'gemini-2.5-flash',
        vertexai: true,
        project: 'p',
        location: 'us-central1',
      });

      await llm.connect(
        createRequest({
          liveConnectConfig: {
            sessionResumption: {handle: 'h-1', transparent: true},
          },
        }),
      );

      expect(llm.liveApiClient.live.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sessionResumption: {handle: 'h-1', transparent: true},
          }),
        }),
      );
    });

    it('leaves a non-transparent resumption config alone', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});

      await llm.connect(
        createRequest({
          liveConnectConfig: {sessionResumption: {handle: 'h-2'}},
        }),
      );

      expect(llm.liveApiClient.live.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({sessionResumption: {handle: 'h-2'}}),
        }),
      );
    });
  });

  describe('preprocessRequest copy-on-write', () => {
    it('leaves the caller inline blob untouched', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const inlineData: Blob = {
        mimeType: 'image/png',
        displayName: 'shot.png',
        data: 'Ynl0ZXM=',
      };
      const part: Part = {inlineData};
      const request = createRequest({
        contents: [{role: 'user', parts: [part]}],
      });
      mockGenerateContent(llm);

      await collectFrom(llm.generateContentAsync(request));

      expect(inlineData.displayName).toBe('shot.png');
      expect(part.inlineData).not.toBe(inlineData);
      expect(part.inlineData?.displayName).toBeUndefined();
      expect(part.inlineData?.data).toBe('Ynl0ZXM=');
    });

    it('leaves the caller file data untouched', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const fileData: FileData = {
        fileUri: 'gs://bucket/file.pdf',
        displayName: 'file.pdf',
      };
      const part: Part = {fileData};
      const request = createRequest({
        contents: [{role: 'user', parts: [part]}],
      });
      mockGenerateContent(llm);

      await collectFrom(llm.generateContentAsync(request));

      expect(fileData.displayName).toBe('file.pdf');
      expect(part.fileData).not.toBe(fileData);
      expect(part.fileData?.displayName).toBeUndefined();
    });

    it('keeps the same object when there is no display name', async () => {
      const llm = new TestGemini({apiKey: 'test-key'});
      const inlineData: Blob = {mimeType: 'image/png', data: 'Ynl0ZXM='};
      const part: Part = {inlineData};
      const request = createRequest({
        contents: [{role: 'user', parts: [part]}],
      });
      mockGenerateContent(llm);

      await collectFrom(llm.generateContentAsync(request));

      expect(part.inlineData).toBe(inlineData);
    });
  });

  describe('debug logging', () => {
    let debugSpy: MockInstance<Logger['debug']>;

    beforeEach(() => {
      debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
      debugSpy.mockRestore();
      resetLogger();
    });

    /** Every string the code under test passed to logger.debug. */
    const debugOutput = () => debugSpy.mock.calls.flat().join('\n');

    for (const level of [LogLevel.INFO, LogLevel.WARN]) {
      it(`builds no request or response log at ${LogLevel[level]}`, async () => {
        setLogLevel(level);
        const llm = new TestGemini({apiKey: 'test-key'});
        mockGenerateContent(llm);

        await collectFrom(
          llm.generateContentAsync(createRequest({model: 'gemini-2.5-flash'})),
        );

        expect(debugOutput()).not.toContain('LLM Request:');
        expect(debugOutput()).not.toContain('LLM Response:');
      });

      it(`builds no streaming response log at ${LogLevel[level]}`, async () => {
        setLogLevel(level);
        const llm = new TestGemini({apiKey: 'test-key'});
        mockGenerateContentStream(llm);

        await collectFrom(
          llm.generateContentAsync(
            createRequest({model: 'gemini-2.5-flash'}),
            true,
          ),
        );

        expect(debugOutput()).not.toContain('LLM Response:');
      });
    }

    it('logs the request and the response at DEBUG', async () => {
      setLogLevel(LogLevel.DEBUG);
      const llm = new TestGemini({apiKey: 'test-key'});
      mockGenerateContent(llm);

      await collectFrom(
        llm.generateContentAsync(createRequest({model: 'gemini-2.5-flash'})),
      );

      expect(debugOutput()).toContain('LLM Request:');
      expect(debugOutput()).toContain('LLM Response:');
    });

    it('logs a response for every streamed chunk at DEBUG', async () => {
      setLogLevel(LogLevel.DEBUG);
      const llm = new TestGemini({apiKey: 'test-key'});
      mockGenerateContentStream(llm);

      await collectFrom(
        llm.generateContentAsync(
          createRequest({model: 'gemini-2.5-flash'}),
          true,
        ),
      );

      expect(debugOutput()).toContain('LLM Response:');
    });

    it('sends the authorization header but never logs it', async () => {
      setLogLevel(LogLevel.DEBUG);
      const llm = new TestGemini({apiKey: 'test-key'});
      const generateContent = mockGenerateContent(llm);
      const request = createRequest({
        model: 'gemini-2.5-flash',
        config: {
          httpOptions: {headers: {Authorization: 'Bearer header-sentinel'}},
        },
      });

      await collectFrom(llm.generateContentAsync(request));

      expect(generateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            httpOptions: expect.objectContaining({
              headers: expect.objectContaining({
                Authorization: 'Bearer header-sentinel',
              }),
            }),
          }),
        }),
      );
      expect(debugOutput()).toContain('LLM Request:');
      expect(debugOutput()).not.toContain('header-sentinel');
    });

    it('sends the live authorization header but never logs it', async () => {
      setLogLevel(LogLevel.DEBUG);
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = createRequest({
        model: 'gemini-2.5-flash',
        liveConnectConfig: {
          httpOptions: {headers: {Authorization: 'Bearer live-sentinel'}},
          responseModalities: [Modality.AUDIO],
        },
      });

      await llm.connect(request);

      expect(llm.liveApiClient.live.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            httpOptions: expect.objectContaining({
              headers: expect.objectContaining({
                Authorization: 'Bearer live-sentinel',
              }),
            }),
          }),
        }),
      );
      expect(debugOutput()).toContain('Live connect config:');
      expect(debugOutput()).toContain('gemini-2.5-flash');
      expect(debugOutput()).toContain(Modality.AUDIO);
      expect(debugOutput()).not.toContain('live-sentinel');
    });

    it('logs the session resumption config it rejects', async () => {
      setLogLevel(LogLevel.DEBUG);
      const llm = new TestGemini({apiKey: 'test-key'});
      const request = createRequest({
        model: 'gemini-2.5-flash',
        liveConnectConfig: {sessionResumption: {transparent: true}},
      });

      await expect(llm.connect(request)).rejects.toThrow(
        'Transparent session resumption',
      );
      expect(debugOutput()).toContain('session resumption config:');
    });
  });
});
