/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CacheMetadata,
  ContextCacheConfig,
  GeminiContextCacheManager,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  CachedContent,
  Content,
  FunctionCallingConfigMode,
  GoogleGenAI,
  Tool,
  ToolUnion,
  Type,
} from '@google/genai';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
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

import {
  applyCacheToRequest,
  cacheScope,
  canonicalJson,
  estimateCacheablePrefixTokens,
  estimateRequestTokens,
  findCountOfContentsToCache,
  generateCacheFingerprint,
  minimumCacheTokens,
} from '../../src/models/gemini_context_cache_manager.js';

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

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 0,
};

const CACHE_NAME = 'projects/test/locations/us-central1/cachedContents/test123';

const TEST_TOOL: Tool = {
  functionDeclarations: [
    {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: Type.OBJECT,
        properties: {param: {type: Type.STRING}},
      },
    },
  ],
};

function userContent(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelContent(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function createLlmRequest(options: {
  contents?: Content[];
  contentsCount?: number;
  cacheMetadata?: CacheMetadata;
  model?: string;
  systemInstruction?: string;
  cacheableContentsTokenCount?: number;
  cacheConfig?: ContextCacheConfig;
}): LlmRequest {
  const contents =
    options.contents ??
    Array.from({length: options.contentsCount ?? 3}, (_unused, index) =>
      userContent(`Test message ${index}`),
    );
  return {
    model: options.model ?? 'gemini-2.5-flash',
    contents,
    config: {
      systemInstruction: options.systemInstruction ?? 'Test instruction',
      tools: [TEST_TOOL],
      toolConfig: {
        functionCallingConfig: {mode: FunctionCallingConfigMode.AUTO},
      },
    },
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: options.cacheConfig ?? CACHE_CONFIG,
    cacheMetadata: options.cacheMetadata,
    cacheableContentsTokenCount: options.cacheableContentsTokenCount,
  };
}

function activeMetadata(options: {
  fingerprint: string;
  contentsCount: number;
  invocationsUsed?: number;
  expired?: boolean;
}): CacheMetadata {
  const nowSeconds = Date.now() / 1000;
  return {
    cacheName: CACHE_NAME,
    expireTime: options.expired ? nowSeconds - 300 : nowSeconds + 1800,
    fingerprint: options.fingerprint,
    invocationsUsed: options.invocationsUsed ?? 1,
    contentsCount: options.contentsCount,
    createdAt: nowSeconds - 600,
  };
}

function geminiClient(): GoogleGenAI {
  return new GoogleGenAI({apiKey: 'test-api-key'});
}

function vertexClient(): GoogleGenAI {
  return new GoogleGenAI({
    vertexai: true,
    project: 'test-project',
    location: 'us-central1',
  });
}

function stubCreate(client: GoogleGenAI, cachedContent: CachedContent) {
  return vi.spyOn(client.caches, 'create').mockResolvedValue(cachedContent);
}

function stubDelete(client: GoogleGenAI) {
  return vi.spyOn(client.caches, 'delete').mockResolvedValue({});
}

/** Recomputes the fingerprint the manager would compare against. */
async function fingerprintOf(
  client: GoogleGenAI,
  llmRequest: LlmRequest,
  contentsCount: number,
): Promise<string> {
  return generateCacheFingerprint(
    llmRequest,
    contentsCount,
    cacheScope(client),
  );
}

beforeEach(() => {
  exporter.reset();
  vi.restoreAllMocks();
});

describe('minimumCacheTokens', () => {
  it('applies the Gemini 2.5 floor', () => {
    expect(minimumCacheTokens('gemini-2.5-flash')).toBe(2048);
  });

  it('applies the Gemini 3 floor', () => {
    expect(minimumCacheTokens('gemini-3.1-pro-preview')).toBe(4096);
  });

  it('reads the last segment of a full resource path', () => {
    expect(
      minimumCacheTokens(
        'projects/p/locations/l/publishers/google/models/gemini-2.5-pro',
      ),
    ).toBe(2048);
  });

  it('applies no floor to an opaque endpoint id', () => {
    expect(
      minimumCacheTokens('projects/p/locations/l/endpoints/tuned-model'),
    ).toBeUndefined();
  });

  it('applies no floor when the model is absent', () => {
    expect(minimumCacheTokens()).toBeUndefined();
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({b: 1, a: {d: 2, c: 3}})).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('passes a primitive through', () => {
    expect(canonicalJson('text')).toBe('"text"');
  });

  it('passes null through', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('returns an empty string for a value JSON cannot represent', () => {
    expect(canonicalJson(undefined)).toBe('');
  });
});

describe('findCountOfContentsToCache', () => {
  it('returns 0 for no contents', () => {
    expect(findCountOfContentsToCache([])).toBe(0);
  });

  it('returns 0 when every content is a user content', () => {
    expect(
      findCountOfContentsToCache([userContent('a'), userContent('b')]),
    ).toBe(0);
  });

  it('stops at the last non-user content', () => {
    expect(
      findCountOfContentsToCache([
        userContent('a'),
        modelContent('b'),
        userContent('c'),
        userContent('d'),
      ]),
    ).toBe(2);
  });

  it('returns every content when the last one is not a user content', () => {
    expect(
      findCountOfContentsToCache([userContent('a'), modelContent('b')]),
    ).toBe(2);
  });
});

describe('estimateRequestTokens', () => {
  it('counts the system instruction, the tools and the content text', () => {
    const llmRequest = createLlmRequest({contentsCount: 2});
    const characters =
      'Test instruction'.length +
      canonicalJson(TEST_TOOL).length +
      'Test message 0'.length +
      'Test message 1'.length;

    expect(estimateRequestTokens(llmRequest)).toBe(Math.floor(characters / 4));
  });

  it('counts only the prefix when a content count is given', () => {
    const llmRequest = createLlmRequest({contentsCount: 2});
    const characters =
      'Test instruction'.length +
      canonicalJson(TEST_TOOL).length +
      'Test message 0'.length;

    expect(estimateRequestTokens(llmRequest, 1)).toBe(
      Math.floor(characters / 4),
    );
  });

  it('counts a system instruction supplied as a list of strings', () => {
    const llmRequest = createLlmRequest({contents: []});
    llmRequest.config = {systemInstruction: ['abcd', 'efgh']};

    expect(estimateRequestTokens(llmRequest)).toBe(2);
  });

  it('counts a system instruction supplied as content', () => {
    const llmRequest = createLlmRequest({contents: []});
    llmRequest.config = {
      systemInstruction: {role: 'user', parts: [{text: 'x'}]},
    };

    expect(estimateRequestTokens(llmRequest)).toBe(
      Math.floor(
        canonicalJson({role: 'user', parts: [{text: 'x'}]}).length / 4,
      ),
    );
  });

  it('counts a system instruction list holding parts', () => {
    const llmRequest = createLlmRequest({contents: []});
    llmRequest.config = {systemInstruction: [{text: 'x'}]};

    expect(estimateRequestTokens(llmRequest)).toBe(
      Math.floor(canonicalJson({text: 'x'}).length / 4),
    );
  });

  it('ignores a part that carries no text', () => {
    const llmRequest = createLlmRequest({
      contents: [
        {role: 'user', parts: [{inlineData: {mimeType: 'image/png'}}]},
      ],
    });
    llmRequest.config = {};

    expect(estimateRequestTokens(llmRequest)).toBe(0);
  });

  it('ignores a content that carries no parts', () => {
    const llmRequest = createLlmRequest({contents: [{role: 'user'}]});
    llmRequest.config = {};

    expect(estimateRequestTokens(llmRequest)).toBe(0);
  });

  it('ignores a tool the SDK calls on the model behalf', () => {
    const callableTool: ToolUnion = {
      tool: () => Promise.resolve({}),
      callTool: () => Promise.resolve([]),
    };
    const llmRequest = createLlmRequest({contents: []});
    llmRequest.config = {tools: [callableTool]};

    expect(estimateRequestTokens(llmRequest)).toBe(0);
  });
});

describe('estimateCacheablePrefixTokens', () => {
  it('returns 0 without an accurate previous token count', () => {
    const llmRequest = createLlmRequest({contentsCount: 2});

    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(0);
  });

  it('scales the accurate count by the prefix share', () => {
    const llmRequest = createLlmRequest({
      contents: [userContent('a'.repeat(400)), userContent('b'.repeat(400))],
      systemInstruction: '',
      cacheableContentsTokenCount: 200,
    });
    llmRequest.config = {tools: []};

    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(100);
  });

  it('never scales above the accurate count', () => {
    const llmRequest = createLlmRequest({
      contents: [userContent('a'.repeat(400))],
      cacheableContentsTokenCount: 200,
    });

    expect(estimateCacheablePrefixTokens(llmRequest, 5)).toBe(200);
  });

  it('falls back to the accurate count when there is no text to scale by', () => {
    const llmRequest = createLlmRequest({
      contents: [
        {role: 'user', parts: [{inlineData: {mimeType: 'image/png'}}]},
      ],
      cacheableContentsTokenCount: 5000,
    });
    llmRequest.config = {};

    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(5000);
  });
});

describe('applyCacheToRequest', () => {
  it('clears the cached fields and points the request at the cache', () => {
    const llmRequest = createLlmRequest({contentsCount: 3});

    applyCacheToRequest(llmRequest, CACHE_NAME, 2);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.config?.tools).toBeUndefined();
    expect(llmRequest.config?.toolConfig).toBeUndefined();
    expect(llmRequest.config?.cachedContent).toBe(CACHE_NAME);
    expect(llmRequest.contents).toEqual([userContent('Test message 2')]);
  });

  it('keeps the final content when the cache covers every content', () => {
    const llmRequest = createLlmRequest({contentsCount: 2});

    applyCacheToRequest(llmRequest, CACHE_NAME, 2);

    expect(llmRequest.contents).toEqual([userContent('Test message 1')]);
  });

  it('leaves an empty request empty', () => {
    const llmRequest = createLlmRequest({contents: []});

    applyCacheToRequest(llmRequest, CACHE_NAME, 3);

    expect(llmRequest.contents).toEqual([]);
  });

  it('creates the config when the request carries none', () => {
    const llmRequest = createLlmRequest({contentsCount: 1});
    llmRequest.config = undefined;

    applyCacheToRequest(llmRequest, CACHE_NAME, 1);

    expect(llmRequest).toMatchObject({config: {cachedContent: CACHE_NAME}});
  });
});

describe('cacheScope', () => {
  it('reports the Gemini backend and its endpoint', () => {
    expect(cacheScope(geminiClient())).toEqual({
      backend: 'gemini',
      base_url: 'https://generativelanguage.googleapis.com/',
    });
  });

  it('reports the Vertex project and location', () => {
    expect(cacheScope(vertexClient())).toEqual({
      backend: 'vertex',
      project: 'test-project',
      location: 'us-central1',
      base_url: 'https://us-central1-aiplatform.googleapis.com/',
    });
  });

  it('reports the backend alone when the client exposes no internals', () => {
    const client = geminiClient();
    Reflect.deleteProperty(client, 'apiClient');

    expect(cacheScope(client)).toEqual({backend: 'gemini'});
  });

  it('reports the backend alone when the internals answer a different shape', () => {
    const client = geminiClient();
    Reflect.set(client, 'apiClient', {getProject: 'not a function'});

    expect(cacheScope(client)).toEqual({backend: 'gemini'});
  });
});

describe('generateCacheFingerprint', () => {
  it('returns 16 hexadecimal characters', async () => {
    const client = geminiClient();
    const fingerprint = await fingerprintOf(
      client,
      createLlmRequest({contentsCount: 3}),
      2,
    );

    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores the order the request fields were built in', async () => {
    const client = geminiClient();
    const first = createLlmRequest({contentsCount: 1});
    const second = createLlmRequest({contentsCount: 1});
    second.config = {
      toolConfig: {
        functionCallingConfig: {mode: FunctionCallingConfigMode.AUTO},
      },
      tools: [TEST_TOOL],
      systemInstruction: 'Test instruction',
    };

    expect(await fingerprintOf(client, first, 1)).toBe(
      await fingerprintOf(client, second, 1),
    );
  });

  it('ignores the order of the tools and of their declarations', async () => {
    const client = geminiClient();
    const alpha = {name: 'alpha', description: 'a'};
    const beta = {name: 'beta', description: 'b'};
    const first = createLlmRequest({contentsCount: 1});
    first.config = {tools: [{functionDeclarations: [alpha, beta]}, TEST_TOOL]};
    const second = createLlmRequest({contentsCount: 1});
    second.config = {tools: [TEST_TOOL, {functionDeclarations: [beta, alpha]}]};

    expect(await fingerprintOf(client, first, 1)).toBe(
      await fingerprintOf(client, second, 1),
    );
  });

  it('sorts declarations that carry no name', async () => {
    const client = geminiClient();
    const first = createLlmRequest({contentsCount: 1});
    first.config = {tools: [{functionDeclarations: [{}, {name: 'alpha'}]}]};
    const second = createLlmRequest({contentsCount: 1});
    second.config = {tools: [{functionDeclarations: [{name: 'alpha'}, {}]}]};

    expect(await fingerprintOf(client, first, 1)).toBe(
      await fingerprintOf(client, second, 1),
    );
  });

  it('keeps a tool that declares no functions', async () => {
    const client = geminiClient();
    const first = createLlmRequest({contentsCount: 1});
    first.config = {tools: [{googleSearch: {}}]};
    const second = createLlmRequest({contentsCount: 1});
    second.config = {tools: [{urlContext: {}}]};

    expect(await fingerprintOf(client, first, 1)).not.toBe(
      await fingerprintOf(client, second, 1),
    );
  });

  it('changes when the tool config changes', async () => {
    const client = geminiClient();
    const first = createLlmRequest({contentsCount: 1});
    const second = createLlmRequest({contentsCount: 1});
    second.config = {...second.config, toolConfig: undefined};

    expect(await fingerprintOf(client, first, 1)).not.toBe(
      await fingerprintOf(client, second, 1),
    );
  });

  it('changes when the system instruction changes', async () => {
    const client = geminiClient();
    const first = createLlmRequest({contentsCount: 1});
    const second = createLlmRequest({
      contentsCount: 1,
      systemInstruction: 'Another instruction',
    });

    expect(await fingerprintOf(client, first, 1)).not.toBe(
      await fingerprintOf(client, second, 1),
    );
  });

  it('changes when the model changes', async () => {
    const client = geminiClient();
    const first = createLlmRequest({contentsCount: 1});
    const second = createLlmRequest({contentsCount: 1, model: 'gemini-3-pro'});

    expect(await fingerprintOf(client, first, 1)).not.toBe(
      await fingerprintOf(client, second, 1),
    );
  });

  it('changes when the backend changes', async () => {
    const llmRequest = createLlmRequest({contentsCount: 1});

    expect(await fingerprintOf(geminiClient(), llmRequest, 1)).not.toBe(
      await fingerprintOf(vertexClient(), llmRequest, 1),
    );
  });

  it('ignores contents beyond the cached prefix', async () => {
    const client = geminiClient();
    const short = createLlmRequest({contents: [userContent('First question')]});
    const grown = createLlmRequest({
      contents: [
        userContent('First question'),
        modelContent('First answer'),
        userContent('Next question'),
      ],
    });

    expect(await fingerprintOf(client, short, 1)).toBe(
      await fingerprintOf(client, grown, 1),
    );
  });

  it('is stable when the prefix is empty', async () => {
    const client = geminiClient();
    const first = createLlmRequest({contents: [userContent('a')]});
    const second = createLlmRequest({contents: [userContent('b')]});

    expect(await fingerprintOf(client, first, 0)).toBe(
      await fingerprintOf(client, second, 0),
    );
  });

  it('is stable when the request carries no contents at all', async () => {
    const client = geminiClient();
    const first = createLlmRequest({contents: []});
    const second = createLlmRequest({contents: []});

    expect(await fingerprintOf(client, first, 2)).toBe(
      await fingerprintOf(client, second, 2),
    );
  });
});

describe('GeminiContextCacheManager.handleContextCaching', () => {
  it('rejects a request that carries no model', async () => {
    const manager = new GeminiContextCacheManager(geminiClient());
    const llmRequest = createLlmRequest({contentsCount: 1});
    llmRequest.model = undefined;

    await expect(manager.handleContextCaching(llmRequest)).rejects.toThrow(
      'Context caching requires a model name.',
    );
  });

  it('rejects a request that carries no cache configuration', async () => {
    const manager = new GeminiContextCacheManager(geminiClient());
    const llmRequest = createLlmRequest({contentsCount: 1});
    llmRequest.cacheConfig = undefined;

    await expect(manager.handleContextCaching(llmRequest)).rejects.toThrow(
      'Context caching requires a cache configuration.',
    );
  });

  it('returns fingerprint-only metadata on the first turn', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/unused'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({
      contents: [userContent('a'), modelContent('b'), userContent('c')],
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata).toEqual({
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    });
    expect(create).not.toHaveBeenCalled();
    expect(llmRequest.config?.cachedContent).toBeUndefined();
  });

  it('reuses a valid cache and copies its metadata', async () => {
    const client = geminiClient();
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({contentsCount: 3});
    const existing = activeMetadata({
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    });
    llmRequest.cacheMetadata = existing;

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata).toEqual(existing);
    expect(metadata).not.toBe(existing);
    expect(llmRequest.config?.cachedContent).toBe(CACHE_NAME);
    expect(llmRequest.contents).toEqual([userContent('Test message 2')]);
  });

  it('keeps the final content when the cache covers the whole request', async () => {
    const client = geminiClient();
    const manager = new GeminiContextCacheManager(client);
    const onlyUser = userContent('Plan the next step');
    const llmRequest = createLlmRequest({contents: [onlyUser]});
    llmRequest.cacheMetadata = activeMetadata({
      fingerprint: await fingerprintOf(client, llmRequest, 1),
      contentsCount: 1,
    });

    await manager.handleContextCaching(llmRequest);

    expect(llmRequest.contents).toEqual([onlyUser]);
    expect(llmRequest.config?.cachedContent).toBe(CACHE_NAME);
  });

  it('replaces an invalidated cache whose prefix still matches', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/grown-prefix'});
    const remove = stubDelete(client);
    const manager = new GeminiContextCacheManager(client);
    const first = userContent('First question');
    const answer = modelContent('First answer');
    const next = userContent('Next question');
    const llmRequest = createLlmRequest({
      contents: [first, answer, next],
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 30_000,
    });
    llmRequest.cacheMetadata = activeMetadata({
      fingerprint: await fingerprintOf(client, llmRequest, 1),
      contentsCount: 1,
      invocationsUsed: 99,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBe('cachedContents/grown-prefix');
    expect(metadata?.contentsCount).toBe(2);
    expect(metadata?.invocationsUsed).toBe(1);
    expect(remove).toHaveBeenCalledWith({name: CACHE_NAME});
    expect(create.mock.calls[0][0].config?.contents).toEqual([first, answer]);
    expect(llmRequest.contents).toEqual([next]);
  });

  it('returns fingerprint-only metadata when the prefix no longer matches', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/unused'});
    const remove = stubDelete(client);
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({
      contents: [userContent('a'), modelContent('b'), userContent('c')],
    });
    llmRequest.cacheMetadata = activeMetadata({
      fingerprint: 'stale-fingerprint',
      contentsCount: 1,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata).toEqual({
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    });
    expect(remove).toHaveBeenCalledWith({name: CACHE_NAME});
    expect(create).not.toHaveBeenCalled();
  });

  it('does not delete anything when the invalid metadata is fingerprint-only', async () => {
    const client = geminiClient();
    const remove = stubDelete(client);
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({contentsCount: 3});
    llmRequest.cacheMetadata = {
      fingerprint: 'stale-fingerprint',
      contentsCount: 1,
    };

    await manager.handleContextCaching(llmRequest);

    expect(remove).not.toHaveBeenCalled();
  });

  it('promotes fingerprint-only metadata to an active cache', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/promoted'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 30_000,
    });
    llmRequest.cacheMetadata = {
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    };

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBe('cachedContents/promoted');
    expect(create).toHaveBeenCalledOnce();
  });

  it('keeps the content count after a failed cache creation', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/unused'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({
      contents: [userContent('a'), modelContent('b'), userContent('c')],
    });
    const previousFingerprint = await fingerprintOf(client, llmRequest, 2);
    llmRequest.cacheMetadata = {
      fingerprint: previousFingerprint,
      contentsCount: 2,
    };

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata).toEqual({
      fingerprint: previousFingerprint,
      contentsCount: 2,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the recorded prefix when the current one is shorter', async () => {
    const client = geminiClient();
    stubCreate(client, {name: 'cachedContents/unused'});
    const manager = new GeminiContextCacheManager(client);
    // Every content is a user content, so the current cacheable prefix is
    // empty while the recorded one covers two.
    const llmRequest = createLlmRequest({contentsCount: 5});
    llmRequest.cacheMetadata = {
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    };

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(findCountOfContentsToCache(llmRequest.contents)).toBe(0);
    expect(metadata?.contentsCount).toBe(2);
    expect(metadata?.fingerprint).toBe(
      await fingerprintOf(client, llmRequest, 2),
    );
  });

  it('never shrinks the prefix when the grown one fails to cache', async () => {
    const client = geminiClient();
    stubCreate(client, {name: 'cachedContents/unused'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({
      contents: [
        userContent('a'),
        modelContent('b'),
        userContent('c'),
        modelContent('d'),
      ],
    });
    llmRequest.cacheMetadata = {
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    };

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.contentsCount).toBe(4);
    expect(metadata?.fingerprint).toBe(
      await fingerprintOf(client, llmRequest, 4),
    );
  });
});

describe('GeminiContextCacheManager cache validity', () => {
  it('rejects an expired cache', async () => {
    const client = geminiClient();
    const remove = stubDelete(client);
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({contentsCount: 3});
    llmRequest.cacheMetadata = activeMetadata({
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
      expired: true,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('rejects a cache used more often than the configured interval', async () => {
    const client = geminiClient();
    stubDelete(client);
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({contentsCount: 3});
    llmRequest.cacheMetadata = activeMetadata({
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
      invocationsUsed: 11,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBeUndefined();
  });

  it('accepts a cache used exactly as often as the configured interval', async () => {
    const client = geminiClient();
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({contentsCount: 3});
    llmRequest.cacheMetadata = activeMetadata({
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
      invocationsUsed: 10,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBe(CACHE_NAME);
  });
});

describe('GeminiContextCacheManager cache creation gates', () => {
  async function invalidatedRequest(
    client: GoogleGenAI,
    options: {
      model?: string;
      systemInstruction?: string;
      contents?: Content[];
      cacheableContentsTokenCount?: number;
      cacheConfig?: ContextCacheConfig;
    },
  ): Promise<LlmRequest> {
    const llmRequest = createLlmRequest({
      contents: options.contents ?? [userContent('a'), modelContent('b')],
      model: options.model,
      systemInstruction: options.systemInstruction,
      cacheableContentsTokenCount: options.cacheableContentsTokenCount,
      cacheConfig: options.cacheConfig,
    });
    llmRequest.cacheMetadata = {
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    };
    return llmRequest;
  }

  it('creates a cache for a Gemini 2.5 model above its floor', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/gemini-25'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = await invalidatedRequest(client, {
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 3_000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBe('cachedContents/gemini-25');
    expect(create).toHaveBeenCalledOnce();
  });

  it('skips the cache for a Gemini 3 model below its floor', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/unused'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = await invalidatedRequest(client, {
      model: 'gemini-3.1-pro-preview',
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 3_000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('applies no floor to an opaque model id', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/tuned-model'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = await invalidatedRequest(client, {
      model: 'projects/test/locations/us-central1/endpoints/tuned-model',
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 3_000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBe('cachedContents/tuned-model');
    expect(create).toHaveBeenCalledOnce();
  });

  it('gates on the cacheable prefix rather than the whole prompt', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/unused'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = await invalidatedRequest(client, {
      contents: [
        userContent('Short prefix.'),
        userContent('word '.repeat(100_000)),
      ],
      systemInstruction: 'You are a helpful assistant.',
      cacheableContentsTokenCount: 75_000,
    });
    llmRequest.cacheMetadata = {
      fingerprint: await fingerprintOf(client, llmRequest, 1),
      contentsCount: 1,
    };

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('skips the cache below the configured minimum token count', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/unused'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = await invalidatedRequest(client, {
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 3_000,
      cacheConfig: {...CACHE_CONFIG, minTokens: 10_000},
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves the request uncached when the cache service fails', async () => {
    const client = geminiClient();
    vi.spyOn(client.caches, 'create').mockRejectedValue(new Error('boom'));
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = await invalidatedRequest(client, {
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 3_000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBeUndefined();
    expect(llmRequest.config?.cachedContent).toBeUndefined();
    expect(llmRequest.config?.systemInstruction).toBe('x'.repeat(12_000));
  });

  it('leaves the request uncached when the service returns no cache name', async () => {
    const client = geminiClient();
    stubCreate(client, {});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = await invalidatedRequest(client, {
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 3_000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata?.cacheName).toBeUndefined();
  });
});

describe('GeminiContextCacheManager cache creation request', () => {
  async function createCache(
    client: GoogleGenAI,
    cachedContent: CachedContent,
    overrides: Partial<LlmRequest> = {},
  ) {
    const create = stubCreate(client, cachedContent);
    const manager = new GeminiContextCacheManager(client);
    const llmRequest: LlmRequest = {
      ...createLlmRequest({
        contents: [userContent('a'), modelContent('b')],
        systemInstruction: 'x'.repeat(12_000),
        cacheableContentsTokenCount: 3_000,
      }),
      ...overrides,
    };
    llmRequest.cacheMetadata = {
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    };
    const metadata = await manager.handleContextCaching(llmRequest);
    return {create, metadata, llmRequest};
  }

  it('sends the ttl, the display name and the cached material', async () => {
    const client = geminiClient();
    const {create} = await createCache(client, {name: 'cachedContents/full'});

    const params = create.mock.calls[0][0];
    expect(params.model).toBe('gemini-2.5-flash');
    expect(params.config?.ttl).toBe('1800s');
    expect(params.config?.displayName).toMatch(/^adk-cache-\d+-2contents$/);
    expect(params.config?.systemInstruction).toBe('x'.repeat(12_000));
    expect(params.config?.tools).toEqual([TEST_TOOL]);
    expect(params.config?.toolConfig).toEqual({
      functionCallingConfig: {mode: 'AUTO'},
    });
    expect(params.config?.httpOptions).toBeUndefined();
  });

  it('passes the cache-creation HTTP options through', async () => {
    const client = geminiClient();
    const {create} = await createCache(
      client,
      {name: 'cachedContents/timeout'},
      {cacheConfig: {...CACHE_CONFIG, createHttpOptions: {timeout: 10_000}}},
    );

    expect(create.mock.calls[0][0].config?.httpOptions).toEqual({
      timeout: 10_000,
    });
  });

  it('omits the cached material the request does not carry', async () => {
    const client = geminiClient();
    const {create} = await createCache(
      client,
      {name: 'cachedContents/bare'},
      {config: {}},
    );

    const config = create.mock.calls[0][0].config;
    expect(config?.systemInstruction).toBeUndefined();
    expect(config?.tools).toBeUndefined();
    expect(config?.toolConfig).toBeUndefined();
  });

  it('omits the contents when the cached prefix is empty', async () => {
    const client = geminiClient();
    const create = stubCreate(client, {name: 'cachedContents/empty-prefix'});
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({
      contents: [userContent('a')],
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 3_000,
    });
    llmRequest.cacheMetadata = {
      fingerprint: await fingerprintOf(client, llmRequest, 0),
      contentsCount: 0,
    };

    await manager.handleContextCaching(llmRequest);

    expect(create.mock.calls[0][0].config?.contents).toBeUndefined();
  });

  it('prefers the expiry the service reports', async () => {
    const client = geminiClient();
    const {metadata} = await createCache(client, {
      name: 'cachedContents/server-expiry',
      expireTime: '2099-01-01T00:00:00Z',
    });

    expect(metadata?.expireTime).toBe(
      Date.parse('2099-01-01T00:00:00Z') / 1000,
    );
  });

  it('falls back to the configured time to live', async () => {
    const client = geminiClient();
    const {metadata} = await createCache(client, {
      name: 'cachedContents/no-expiry',
    });

    expect(metadata?.expireTime).toBeCloseTo(Date.now() / 1000 + 1800, -1);
  });

  it('records the cache in a create_cache span', async () => {
    const client = geminiClient();
    await createCache(client, {name: 'cachedContents/spanned'});

    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'create_cache');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toMatchObject({
      cache_contents_count: 2,
      model: 'gemini-2.5-flash',
      ttl_seconds: 1800,
      cache_name: 'cachedContents/spanned',
    });
  });

  it('ends the create_cache span when the cache service fails', async () => {
    const client = geminiClient();
    vi.spyOn(client.caches, 'create').mockRejectedValue(new Error('boom'));
    const manager = new GeminiContextCacheManager(client);
    const llmRequest = createLlmRequest({
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12_000),
      cacheableContentsTokenCount: 3_000,
    });
    llmRequest.cacheMetadata = {
      fingerprint: await fingerprintOf(client, llmRequest, 2),
      contentsCount: 2,
    };

    await manager.handleContextCaching(llmRequest);

    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'create_cache');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['cache_name']).toBeUndefined();
  });
});

describe('GeminiContextCacheManager.cleanupCache', () => {
  it('deletes the cache', async () => {
    const client = geminiClient();
    const remove = stubDelete(client);
    const manager = new GeminiContextCacheManager(client);

    await manager.cleanupCache(CACHE_NAME);

    expect(remove).toHaveBeenCalledWith({name: CACHE_NAME});
  });

  it('swallows a deletion failure', async () => {
    const client = geminiClient();
    vi.spyOn(client.caches, 'delete').mockRejectedValue(new Error('gone'));
    const manager = new GeminiContextCacheManager(client);

    await expect(manager.cleanupCache(CACHE_NAME)).resolves.toBeUndefined();
  });
});

describe('GeminiContextCacheManager.populateCacheMetadataInResponse', () => {
  it('copies the metadata onto the response', () => {
    const manager = new GeminiContextCacheManager(geminiClient());
    const metadata = activeMetadata({fingerprint: 'fp', contentsCount: 2});
    const llmResponse: LlmResponse = {};

    manager.populateCacheMetadataInResponse(llmResponse, metadata);

    expect(llmResponse.cacheMetadata).toEqual(metadata);
    expect(llmResponse.cacheMetadata).not.toBe(metadata);
  });

  it('does not change how often the cache has been used', () => {
    const manager = new GeminiContextCacheManager(geminiClient());
    const metadata = activeMetadata({
      fingerprint: 'fp',
      contentsCount: 2,
      invocationsUsed: 3,
    });
    const llmResponse: LlmResponse = {};

    manager.populateCacheMetadataInResponse(llmResponse, metadata);

    expect(llmResponse.cacheMetadata?.invocationsUsed).toBe(3);
    expect(metadata.invocationsUsed).toBe(3);
  });
});
