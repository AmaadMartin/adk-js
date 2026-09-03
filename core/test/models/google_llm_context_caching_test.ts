/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveCacheMetadata,
  ContextCacheConfig,
  Gemini,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  Content,
  GenerateContentResponse,
  GoogleGenAI,
  GoogleGenAIOptions,
} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation((options: GoogleGenAIOptions) => ({
      models: {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(),
      },
      caches: {
        create: vi.fn(),
        delete: vi.fn(),
      },
      interactions: {
        create: vi.fn(),
      },
      vertexai: options.vertexai ?? false,
    })),
  };
});

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
});

const API_KEY = 'test-api-key';
const CACHE_NAME = 'projects/test/locations/us-central1/cachedContents/test123';

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 0,
};

function userContent(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelContent(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function createLlmRequest(
  contents: Content[],
  cacheConfig?: ContextCacheConfig,
): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents,
    config: {systemInstruction: 'You are a helpful assistant.'},
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig,
  };
}

function modelResponse(text: string): GenerateContentResponse {
  const response = new GenerateContentResponse();
  Object.assign(response, {
    candidates: [{content: modelContent(text), finishReason: 'STOP'}],
    usageMetadata: {promptTokenCount: 1000, cachedContentTokenCount: 500},
  });
  return response;
}

async function* streamOf(
  ...responses: GenerateContentResponse[]
): AsyncGenerator<GenerateContentResponse> {
  for (const response of responses) {
    yield response;
  }
}

async function collect(
  gemini: Gemini,
  llmRequest: LlmRequest,
  stream = false,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of gemini.generateContentAsync(
    llmRequest,
    stream,
  )) {
    responses.push(response);
  }
  return responses;
}

function cachingSpans(): ReadableSpan[] {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.name === 'handle_context_caching');
}

describe('Gemini context caching', () => {
  let gemini: Gemini;
  let client: GoogleGenAI;

  beforeEach(() => {
    exporter.reset();
    gemini = new Gemini({model: 'gemini-2.5-flash', apiKey: API_KEY});
    client = gemini.apiClient;
  });

  it('annotates a non-streaming response with the cache metadata', async () => {
    vi.mocked(client.models.generateContent).mockResolvedValue(
      modelResponse('Hello'),
    );
    const llmRequest = createLlmRequest(
      [userContent('a'), modelContent('b'), userContent('c')],
      CACHE_CONFIG,
    );

    const [response] = await collect(gemini, llmRequest);

    expect(response.cacheMetadata).toEqual({
      fingerprint: expect.any(String),
      contentsCount: 2,
    });
    expect(response.usageMetadata?.cachedContentTokenCount).toBe(500);
  });

  it('annotates only the final aggregated streaming response', async () => {
    vi.mocked(client.models.generateContentStream).mockResolvedValue(
      streamOf(modelResponse('Hel'), modelResponse('lo')),
    );
    const llmRequest = createLlmRequest(
      [userContent('a'), modelContent('b'), userContent('c')],
      CACHE_CONFIG,
    );

    const responses = await collect(gemini, llmRequest, true);

    expect(responses.length).toBeGreaterThan(1);
    const final = responses[responses.length - 1];
    expect(final.partial).not.toBe(true);
    expect(final.cacheMetadata?.contentsCount).toBe(2);
    for (const partial of responses.slice(0, -1)) {
      expect(partial.cacheMetadata).toBeUndefined();
    }
  });

  it('reads the request prefix from an active cache', async () => {
    vi.mocked(client.models.generateContent).mockResolvedValue(
      modelResponse('Hello'),
    );
    // Turn one fingerprints the prefix that turn two's cache stands for.
    const [firstTurn] = await collect(
      gemini,
      createLlmRequest([userContent('a'), modelContent('b')], CACHE_CONFIG),
    );
    const fingerprint = firstTurn.cacheMetadata?.fingerprint;
    if (fingerprint === undefined) {
      expect.fail('the first turn produced no fingerprint');
    }

    const llmRequest = createLlmRequest(
      [userContent('a'), modelContent('b'), userContent('c')],
      CACHE_CONFIG,
    );
    const existing: ActiveCacheMetadata = {
      cacheName: CACHE_NAME,
      expireTime: Date.now() / 1000 + 1800,
      invocationsUsed: 1,
      contentsCount: 2,
      fingerprint,
    };
    llmRequest.cacheMetadata = existing;

    const [response] = await collect(gemini, llmRequest);

    expect(llmRequest.config?.cachedContent).toBe(CACHE_NAME);
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents).toEqual([userContent('c')]);
    expect(response.cacheMetadata).toEqual(existing);
    const sent = vi.mocked(client.models.generateContent).mock.calls[1][0];
    expect(sent.contents).toEqual([userContent('c')]);
    expect(sent.config?.cachedContent).toBe(CACHE_NAME);

    const [, second] = cachingSpans();
    expect(second.attributes['cache_action']).toBe('active_cache');
    expect(second.attributes['cache_name']).toBe(CACHE_NAME);
  });

  it('records a fingerprint-only caching span on the first turn', async () => {
    vi.mocked(client.models.generateContent).mockResolvedValue(
      modelResponse('Hello'),
    );

    await collect(
      gemini,
      createLlmRequest([userContent('a'), modelContent('b')], CACHE_CONFIG),
    );

    const [span] = cachingSpans();
    expect(span.attributes['cache_action']).toBe('fingerprint_only');
    expect(span.attributes['cache_name']).toBeUndefined();
  });

  it('opens no caching span when no cache config is set', async () => {
    vi.mocked(client.models.generateContent).mockResolvedValue(
      modelResponse('Hello'),
    );

    await collect(gemini, createLlmRequest([userContent('a')]));

    expect(cachingSpans()).toEqual([]);
  });

  it('ends the caching span when the manager throws', async () => {
    const llmRequest = createLlmRequest([userContent('a')], CACHE_CONFIG);
    llmRequest.model = undefined;

    await expect(collect(gemini, llmRequest)).rejects.toThrow(/model name/);

    const [span] = cachingSpans();
    expect(span.attributes['cache_action']).toBeUndefined();
    expect(span.ended).toBe(true);
  });

  it('leaves the request alone when no cache config is set', async () => {
    vi.mocked(client.models.generateContent).mockResolvedValue(
      modelResponse('Hello'),
    );
    const llmRequest = createLlmRequest([userContent('a')]);

    const [response] = await collect(gemini, llmRequest);

    expect(response.cacheMetadata).toBeUndefined();
    expect(client.caches.create).not.toHaveBeenCalled();
    expect(client.caches.delete).not.toHaveBeenCalled();
    expect(llmRequest.config?.cachedContent).toBeUndefined();
  });

  it('never applies an explicit cache on the interactions API', async () => {
    const interactionsGemini = new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: API_KEY,
      useInteractionsApi: true,
    });
    const interactionsClient = interactionsGemini.apiClient;
    vi.mocked(interactionsClient.interactions.create).mockResolvedValue({
      id: 'interaction-1',
      status: 'completed',
      steps: [],
    });
    const contents = [userContent('a'), modelContent('b'), userContent('c')];
    const llmRequest = createLlmRequest(contents, CACHE_CONFIG);

    const [response] = await collect(interactionsGemini, llmRequest);

    expect(interactionsClient.caches.create).not.toHaveBeenCalled();
    expect(interactionsClient.caches.delete).not.toHaveBeenCalled();
    expect(llmRequest.contents).toEqual(contents);
    expect(llmRequest.config?.systemInstruction).toBe(
      'You are a helpful assistant.',
    );
    expect(llmRequest.config?.cachedContent).toBeUndefined();
    expect(response.cacheMetadata).toBeUndefined();
  });
});
