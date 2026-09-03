/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CacheMetadata,
  ContextCacheConfig,
  Gemini,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  Content,
  FinishReason,
  GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
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

beforeEach(() => {
  exporter.reset();
  vi.restoreAllMocks();
});

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 0,
};

const CACHE_NAME = 'cachedContents/turn-two';

function userContent(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelContent(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function createLlmRequest(options: {
  contents: Content[];
  cacheConfig?: ContextCacheConfig;
  cacheMetadata?: CacheMetadata;
  cacheableContentsTokenCount?: number;
  systemInstruction?: string;
}): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents: options.contents,
    config: {systemInstruction: options.systemInstruction ?? 'Be helpful.'},
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: options.cacheConfig,
    cacheMetadata: options.cacheMetadata,
    cacheableContentsTokenCount: options.cacheableContentsTokenCount,
  };
}

function modelAnswer(text: string, cachedTokens = 0): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [
    {content: modelContent(text), finishReason: FinishReason.STOP},
  ];
  response.usageMetadata = {
    promptTokenCount: 30_000,
    cachedContentTokenCount: cachedTokens,
  };
  return response;
}

function stubModel(client: GoogleGenAI, response: GenerateContentResponse) {
  return vi.spyOn(client.models, 'generateContent').mockResolvedValue(response);
}

function stubStream(
  client: GoogleGenAI,
  chunks: GenerateContentResponse[],
): void {
  vi.spyOn(client.models, 'generateContentStream').mockResolvedValue(
    (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  );
}

async function collect(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

function spansNamed(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

/** A request whose prefix is large enough to clear the Gemini 2.5 floor. */
function cacheableSecondTurn(previous: CacheMetadata): LlmRequest {
  return createLlmRequest({
    contents: [
      userContent('First question'),
      modelContent('First answer'),
      userContent('Second question'),
    ],
    systemInstruction: 'x'.repeat(12_000),
    cacheConfig: CACHE_CONFIG,
    cacheMetadata: previous,
    cacheableContentsTokenCount: 30_000,
  });
}

describe('Gemini context caching', () => {
  it('reports fingerprint-only metadata on the first turn', async () => {
    const llm = new Gemini({apiKey: 'test-api-key'});
    const client = llm.apiClient;
    stubModel(client, modelAnswer('First answer'));
    const create = vi
      .spyOn(client.caches, 'create')
      .mockResolvedValue({name: CACHE_NAME});
    const llmRequest = createLlmRequest({
      contents: [userContent('First question')],
      systemInstruction: 'x'.repeat(12_000),
      cacheConfig: CACHE_CONFIG,
    });

    const [response] = await collect(llm.generateContentAsync(llmRequest));

    expect(response.cacheMetadata).toBeDefined();
    expect(response.cacheMetadata?.cacheName).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(llmRequest.config?.cachedContent).toBeUndefined();
  });

  it('creates the cache on the second turn and reports it', async () => {
    const llm = new Gemini({apiKey: 'test-api-key'});
    const client = llm.apiClient;
    stubModel(client, modelAnswer('First answer'));
    vi.spyOn(client.caches, 'create').mockResolvedValue({name: CACHE_NAME});
    const firstRequest = createLlmRequest({
      contents: [userContent('First question')],
      systemInstruction: 'x'.repeat(12_000),
      cacheConfig: CACHE_CONFIG,
    });

    const [firstResponse] = await collect(
      llm.generateContentAsync(firstRequest),
    );
    const firstMetadata = firstResponse.cacheMetadata;
    if (!firstMetadata) {
      expect.fail('the first turn reported no cache metadata');
    }

    const generate = stubModel(client, modelAnswer('Second answer', 2_500));
    const secondRequest = cacheableSecondTurn(firstMetadata);

    const [secondResponse] = await collect(
      llm.generateContentAsync(secondRequest),
    );

    expect(secondResponse.cacheMetadata?.cacheName).toBe(CACHE_NAME);
    expect(secondResponse.cacheMetadata?.invocationsUsed).toBe(1);
    expect(secondResponse.usageMetadata?.cachedContentTokenCount).toBe(2_500);
    expect(secondRequest.config?.cachedContent).toBe(CACHE_NAME);
    expect(secondRequest.config?.systemInstruction).toBeUndefined();
    expect(generate.mock.calls[0][0].contents).toEqual([
      userContent('Second question'),
    ]);
  });

  it('reports the cache only on the final aggregated streamed response', async () => {
    const llm = new Gemini({apiKey: 'test-api-key'});
    const client = llm.apiClient;
    vi.spyOn(client.caches, 'create').mockResolvedValue({name: CACHE_NAME});
    stubStream(client, [modelAnswer('Hello '), modelAnswer('world')]);
    const firstMetadata = await firstTurnMetadata(llm);

    const responses = await collect(
      llm.generateContentAsync(cacheableSecondTurn(firstMetadata), true),
    );

    expect(responses.length).toBeGreaterThan(1);
    for (const partial of responses.slice(0, -1)) {
      expect(partial.cacheMetadata).toBeUndefined();
    }
    expect(responses[responses.length - 1].cacheMetadata?.cacheName).toBe(
      CACHE_NAME,
    );
  });

  it('leaves a request without a cache configuration untouched', async () => {
    const llm = new Gemini({apiKey: 'test-api-key'});
    const client = llm.apiClient;
    stubModel(client, modelAnswer('Answer'));
    const create = vi
      .spyOn(client.caches, 'create')
      .mockResolvedValue({name: CACHE_NAME});
    const llmRequest = createLlmRequest({
      contents: [userContent('Question')],
    });

    const [response] = await collect(llm.generateContentAsync(llmRequest));

    expect(response.cacheMetadata).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(llmRequest.config?.cachedContent).toBeUndefined();
    expect(llmRequest.config?.systemInstruction).toBe('Be helpful.');
    expect(spansNamed('handle_context_caching')).toHaveLength(0);
  });

  it('never caches on the Interactions API path', async () => {
    const llm = new Gemini({apiKey: 'test-api-key', useInteractionsApi: true});
    const client = llm.apiClient;
    const create = vi
      .spyOn(client.caches, 'create')
      .mockResolvedValue({name: CACHE_NAME});
    // The interactions call is the first thing this path does, so failing it
    // proves the caching block never ran before it.
    vi.spyOn(client.interactions, 'create').mockRejectedValue(
      new Error('interactions reached'),
    );
    const llmRequest = createLlmRequest({
      contents: [userContent('Question')],
      cacheConfig: CACHE_CONFIG,
      cacheableContentsTokenCount: 30_000,
    });

    await expect(collect(llm.generateContentAsync(llmRequest))).rejects.toThrow(
      'interactions reached',
    );

    expect(create).not.toHaveBeenCalled();
    expect(llmRequest.config?.cachedContent).toBeUndefined();
    expect(llmRequest.config?.systemInstruction).toBe('Be helpful.');
    expect(llmRequest.contents).toEqual([userContent('Question')]);
    expect(spansNamed('handle_context_caching')).toHaveLength(0);
  });
});

describe('Gemini handle_context_caching span', () => {
  it('records a fingerprint-only turn', async () => {
    const llm = new Gemini({apiKey: 'test-api-key'});
    stubModel(llm.apiClient, modelAnswer('First answer'));

    await collect(
      llm.generateContentAsync(
        createLlmRequest({
          contents: [userContent('First question')],
          cacheConfig: CACHE_CONFIG,
        }),
      ),
    );

    const spans = spansNamed('handle_context_caching');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['cache_action']).toBe('fingerprint_only');
    expect(spans[0].attributes['cache_name']).toBeUndefined();
  });

  it('records an active cache turn', async () => {
    const llm = new Gemini({apiKey: 'test-api-key'});
    const client = llm.apiClient;
    vi.spyOn(client.caches, 'create').mockResolvedValue({name: CACHE_NAME});
    stubModel(client, modelAnswer('First answer'));
    const firstMetadata = await firstTurnMetadata(llm);
    exporter.reset();

    await collect(llm.generateContentAsync(cacheableSecondTurn(firstMetadata)));

    const spans = spansNamed('handle_context_caching');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['cache_action']).toBe('active_cache');
    expect(spans[0].attributes['cache_name']).toBe(CACHE_NAME);
  });
});

/** Runs a first turn and returns the fingerprint-only metadata it reports. */
async function firstTurnMetadata(llm: Gemini): Promise<CacheMetadata> {
  stubModel(llm.apiClient, modelAnswer('First answer'));
  const [response] = await collect(
    llm.generateContentAsync(
      createLlmRequest({
        contents: [userContent('First question')],
        systemInstruction: 'x'.repeat(12_000),
        cacheConfig: CACHE_CONFIG,
      }),
    ),
  );
  const metadata = response.cacheMetadata;
  if (!metadata) {
    expect.fail('the first turn reported no cache metadata');
  }
  return metadata;
}
