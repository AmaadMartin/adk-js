/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveCacheMetadata,
  CacheMetadata,
  ContextCacheConfig,
} from '@google/adk';
import {
  CachedContent,
  Content,
  CreateCachedContentConfig,
  DeleteCachedContentResponse,
  FunctionCallingConfigMode,
  Tool,
  ToolConfig,
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
  type Mock,
  vi,
} from 'vitest';

import {
  applyCacheToRequest,
  CacheClient,
  CacheScope,
  contentUnionCharacterCount,
  estimateCacheablePrefixTokens,
  estimateRequestTokens,
  findCountOfContentsToCache,
  GeminiContextCacheManager,
  generateCacheFingerprint,
  isCacheValid,
  minimumCacheTokens,
  populateCacheMetadataInResponse,
} from '../../src/models/gemini_context_cache_manager.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';

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

const GEMINI_SCOPE: CacheScope = {backend: 'gemini'};
const VERTEX_SCOPE: CacheScope = {
  backend: 'vertex',
  project: 'test-project',
  location: 'us-central1',
};
const CACHE_NAME = 'projects/test/locations/us-central1/cachedContents/test123';

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 0,
};

const TOOLS: Tool[] = [
  {
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
  },
];

const TOOL_CONFIG: ToolConfig = {
  functionCallingConfig: {mode: FunctionCallingConfigMode.AUTO},
};

function userContent(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelContent(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

interface RequestOptions {
  contents?: Content[];
  contentsCount?: number;
  cacheMetadata?: CacheMetadata;
  model?: string;
  systemInstruction?: string;
  cacheConfig?: ContextCacheConfig;
  cacheableContentsTokenCount?: number;
}

function createLlmRequest(options: RequestOptions = {}): LlmRequest {
  const contentsCount = options.contentsCount ?? 3;
  const contents =
    options.contents ??
    Array.from({length: contentsCount}, (_unused, index) =>
      userContent(`Test message ${index}`),
    );
  return {
    model: options.model ?? 'gemini-2.5-flash',
    contents,
    config: {
      systemInstruction: options.systemInstruction ?? 'Test instruction',
      tools: TOOLS,
      toolConfig: TOOL_CONFIG,
    },
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: options.cacheConfig ?? CACHE_CONFIG,
    cacheMetadata: options.cacheMetadata,
    cacheableContentsTokenCount: options.cacheableContentsTokenCount,
  };
}

function activeMetadata(
  overrides: Partial<ActiveCacheMetadata> = {},
): ActiveCacheMetadata {
  const now = Date.now() / 1000;
  return {
    cacheName: CACHE_NAME,
    expireTime: now + 1800,
    fingerprint: 'test_fingerprint',
    invocationsUsed: 1,
    contentsCount: 3,
    createdAt: now - 600,
    ...overrides,
  };
}

interface FakeClient extends CacheClient {
  readonly caches: {
    create: Mock<CacheClient['caches']['create']>;
    delete: Mock<CacheClient['caches']['delete']>;
  };
}

function createFakeClient(cachedContent: CachedContent = {}): FakeClient {
  const deleteResponse: DeleteCachedContentResponse = {};
  return {
    caches: {
      create: vi.fn().mockResolvedValue(cachedContent),
      delete: vi.fn().mockResolvedValue(deleteResponse),
    },
  };
}

/** Returns the config of the single `caches.create` call the client received. */
function createdCacheConfig(client: FakeClient): CreateCachedContentConfig {
  const [parameters] = client.caches.create.mock.calls[0];
  if (parameters.config === undefined) {
    expect.fail('caches.create was called without a config');
  }
  return parameters.config;
}

/**
 * Returns the fingerprint the manager stores for a request with no prior
 * cache, which is the value a later turn compares against.
 */
async function fingerprintOf(
  llmRequest: LlmRequest,
  scope: CacheScope = GEMINI_SCOPE,
): Promise<string> {
  const manager = new GeminiContextCacheManager(createFakeClient(), scope);
  const metadata = await manager.handleContextCaching(llmRequest);
  return metadata.fingerprint;
}

describe('minimumCacheTokens', () => {
  it('applies the 2048-token floor to the gemini-2.5 family', () => {
    expect(minimumCacheTokens('gemini-2.5-flash')).toBe(2048);
  });

  it('applies the 4096-token floor to the gemini-3 family', () => {
    expect(minimumCacheTokens('gemini-3.1-pro-preview')).toBe(4096);
  });

  it('reads the floor from the last segment of a resource path', () => {
    expect(
      minimumCacheTokens(
        'projects/p/locations/us-central1/publishers/google/models/gemini-2.5-pro',
      ),
    ).toBe(2048);
  });

  it('applies no floor to an opaque endpoint id', () => {
    expect(
      minimumCacheTokens('projects/p/locations/us-central1/endpoints/tuned'),
    ).toBeUndefined();
  });

  it('applies no floor when the model is absent', () => {
    expect(minimumCacheTokens()).toBeUndefined();
  });
});

describe('findCountOfContentsToCache', () => {
  it('caches nothing when there are no contents', () => {
    expect(findCountOfContentsToCache([])).toBe(0);
  });

  it('caches nothing when every content is a user content', () => {
    expect(
      findCountOfContentsToCache([userContent('a'), userContent('b')]),
    ).toBe(0);
  });

  it('caches everything before the last user batch', () => {
    expect(
      findCountOfContentsToCache([
        userContent('a'),
        modelContent('b'),
        userContent('c'),
        userContent('d'),
      ]),
    ).toBe(2);
  });

  it('caches every content when the last one is not a user content', () => {
    expect(
      findCountOfContentsToCache([userContent('a'), modelContent('b')]),
    ).toBe(2);
  });
});

describe('contentUnionCharacterCount', () => {
  it('counts the characters of a text instruction', () => {
    expect(contentUnionCharacterCount('abcde')).toBe(5);
  });

  it('counts a list of text and structured parts', () => {
    expect(contentUnionCharacterCount(['abc', {text: 'de'}])).toBe(
      3 + '{"text":"de"}'.length,
    );
  });

  it('counts a structured instruction', () => {
    expect(contentUnionCharacterCount({text: 'de'})).toBe(
      '{"text":"de"}'.length,
    );
  });
});

describe('estimateRequestTokens', () => {
  it('counts the system instruction, the tools and every content', () => {
    const llmRequest = createLlmRequest({contentsCount: 2});
    const full = estimateRequestTokens(llmRequest);
    const prefix = estimateRequestTokens(llmRequest, 1);
    expect(full).toBeGreaterThan(prefix);
  });

  it('ignores a callable tool that carries no declaration', () => {
    const llmRequest = createLlmRequest({contentsCount: 0});
    const withDeclarativeToolOnly = estimateRequestTokens(llmRequest);
    llmRequest.config = {
      ...llmRequest.config,
      tools: [...TOOLS, {tool: async () => TOOLS[0], callTool: async () => []}],
    };
    expect(estimateRequestTokens(llmRequest)).toBe(withDeclarativeToolOnly);
  });

  it('ignores a content that carries no parts', () => {
    const llmRequest = createLlmRequest({contents: [{role: 'user'}]});
    llmRequest.config = {};
    expect(estimateRequestTokens(llmRequest)).toBe(0);
  });

  it('ignores a part that carries no text', () => {
    const llmRequest = createLlmRequest({
      contents: [{role: 'user', parts: [{inlineData: {data: 'AAAA'}}]}],
      systemInstruction: '',
    });
    llmRequest.config = {};
    expect(estimateRequestTokens(llmRequest)).toBe(0);
  });
});

describe('estimateCacheablePrefixTokens', () => {
  it('returns zero without a previous prompt token count', () => {
    expect(estimateCacheablePrefixTokens(createLlmRequest(), 2)).toBe(0);
  });

  it('scales the accurate count by the prefix share of the request', () => {
    const llmRequest = createLlmRequest({
      contents: [userContent('a'.repeat(400)), userContent('b'.repeat(400))],
      systemInstruction: '',
      cacheableContentsTokenCount: 1000,
    });
    llmRequest.config = {};
    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(500);
  });

  it('returns the accurate count when there is no text to scale by', () => {
    const llmRequest = createLlmRequest({
      contents: [{role: 'user', parts: [{inlineData: {data: 'AAAA'}}]}],
      cacheableContentsTokenCount: 900,
    });
    llmRequest.config = {};
    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(900);
  });
});

describe('applyCacheToRequest', () => {
  it('moves the cached prefix and the tools into the cache reference', () => {
    const llmRequest = createLlmRequest({contentsCount: 3});

    applyCacheToRequest(llmRequest, CACHE_NAME, 2);

    expect(llmRequest.config?.cachedContent).toBe(CACHE_NAME);
    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.config?.tools).toBeUndefined();
    expect(llmRequest.config?.toolConfig).toBeUndefined();
    expect(llmRequest.contents).toEqual([userContent('Test message 2')]);
  });

  it('keeps the final content when the cache covers the whole request', () => {
    const llmRequest = createLlmRequest({contentsCount: 2});

    applyCacheToRequest(llmRequest, CACHE_NAME, 2);

    expect(llmRequest.contents).toEqual([userContent('Test message 1')]);
  });

  it('creates the config when the request has none', () => {
    const llmRequest = createLlmRequest();
    llmRequest.config = undefined;

    applyCacheToRequest(llmRequest, CACHE_NAME, 0);

    expect(llmRequest.config).toEqual({cachedContent: CACHE_NAME});
  });
});

describe('generateCacheFingerprint', () => {
  it('is stable for the same request', async () => {
    const llmRequest = createLlmRequest();
    const first = await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE);
    const second = await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE);
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
  });

  it('does not depend on the key order of the request config', async () => {
    const llmRequest = createLlmRequest();
    const reordered = createLlmRequest();
    reordered.config = {
      toolConfig: TOOL_CONFIG,
      tools: TOOLS,
      systemInstruction: 'Test instruction',
    };
    expect(await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(reordered, 2, GEMINI_SCOPE),
    );
  });

  it('does not depend on the order of the tool list', async () => {
    const first: Tool = {functionDeclarations: [{name: 'alpha'}]};
    const second: Tool = {functionDeclarations: [{name: 'beta'}]};
    const forward = createLlmRequest();
    forward.config = {tools: [first, second]};
    const reversed = createLlmRequest();
    reversed.config = {tools: [second, first]};

    expect(await generateCacheFingerprint(forward, 0, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(reversed, 0, GEMINI_SCOPE),
    );
  });

  it('does not depend on the order of the function declarations', async () => {
    const forward = createLlmRequest();
    forward.config = {
      tools: [{functionDeclarations: [{name: 'alpha'}, {name: 'beta'}]}],
    };
    const reversed = createLlmRequest();
    reversed.config = {
      tools: [{functionDeclarations: [{name: 'beta'}, {name: 'alpha'}]}],
    };

    expect(await generateCacheFingerprint(forward, 0, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(reversed, 0, GEMINI_SCOPE),
    );
  });

  it('sorts a declaration that carries no name', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.config = {
      tools: [{functionDeclarations: [{name: 'alpha'}, {}]}],
    };
    const reversed = createLlmRequest();
    reversed.config = {
      tools: [{functionDeclarations: [{}, {name: 'alpha'}]}],
    };

    expect(await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(reversed, 0, GEMINI_SCOPE),
    );
  });

  it('ignores a tool that carries no function declarations', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.config = {tools: [{googleSearch: {}}]};
    await expect(
      generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    ).resolves.toHaveLength(16);
  });

  it('ignores content beyond the cached prefix', async () => {
    const shared = [userContent('a'), userContent('b')];
    const shorter = createLlmRequest({contents: shared});
    const longer = createLlmRequest({
      contents: [...shared, userContent('c')],
    });

    expect(await generateCacheFingerprint(shorter, 2, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(longer, 2, GEMINI_SCOPE),
    );
  });

  it('changes when the system instruction changes', async () => {
    const before = createLlmRequest({systemInstruction: 'Instruction A'});
    const after = createLlmRequest({systemInstruction: 'Instruction B'});

    expect(await generateCacheFingerprint(before, 0, GEMINI_SCOPE)).not.toBe(
      await generateCacheFingerprint(after, 0, GEMINI_SCOPE),
    );
  });

  it('changes when the backend scope changes', async () => {
    const llmRequest = createLlmRequest();

    expect(
      await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE),
    ).not.toBe(await generateCacheFingerprint(llmRequest, 2, VERTEX_SCOPE));
  });

  it('changes when the model changes', async () => {
    expect(
      await generateCacheFingerprint(
        createLlmRequest({model: 'gemini-2.5-flash'}),
        0,
        GEMINI_SCOPE,
      ),
    ).not.toBe(
      await generateCacheFingerprint(
        createLlmRequest({model: 'gemini-2.5-pro'}),
        0,
        GEMINI_SCOPE,
      ),
    );
  });

  it('fingerprints a request that carries no config', async () => {
    const llmRequest = createLlmRequest({contents: []});
    llmRequest.config = undefined;
    await expect(
      generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    ).resolves.toHaveLength(16);
  });
});

describe('isCacheValid', () => {
  it('accepts a live cache that still matches the request', async () => {
    const llmRequest = createLlmRequest();
    const fingerprint = await generateCacheFingerprint(
      llmRequest,
      3,
      GEMINI_SCOPE,
    );

    await expect(
      isCacheValid(
        llmRequest,
        activeMetadata({fingerprint}),
        CACHE_CONFIG,
        GEMINI_SCOPE,
      ),
    ).resolves.toBe(true);
  });

  it('rejects an expired cache', async () => {
    const llmRequest = createLlmRequest();
    const expireTime = Date.now() / 1000 - 300;

    await expect(
      isCacheValid(
        llmRequest,
        activeMetadata({expireTime}),
        CACHE_CONFIG,
        GEMINI_SCOPE,
      ),
    ).resolves.toBe(false);
  });

  it('rejects a cache that used up its interval budget', async () => {
    const llmRequest = createLlmRequest();

    await expect(
      isCacheValid(
        llmRequest,
        activeMetadata({invocationsUsed: 11}),
        CACHE_CONFIG,
        GEMINI_SCOPE,
      ),
    ).resolves.toBe(false);
  });

  it('accepts a cache that has exactly reached its interval budget', async () => {
    const llmRequest = createLlmRequest();
    const fingerprint = await generateCacheFingerprint(
      llmRequest,
      3,
      GEMINI_SCOPE,
    );

    await expect(
      isCacheValid(
        llmRequest,
        activeMetadata({fingerprint, invocationsUsed: 10}),
        CACHE_CONFIG,
        GEMINI_SCOPE,
      ),
    ).resolves.toBe(true);
  });

  it('rejects a cache whose fingerprint no longer matches', async () => {
    await expect(
      isCacheValid(
        createLlmRequest(),
        activeMetadata(),
        CACHE_CONFIG,
        GEMINI_SCOPE,
      ),
    ).resolves.toBe(false);
  });
});

describe('populateCacheMetadataInResponse', () => {
  it('copies the metadata without advancing the use count', () => {
    const llmResponse: LlmResponse = {
      usageMetadata: {promptTokenCount: 1000, cachedContentTokenCount: 500},
    };
    const metadata = activeMetadata({invocationsUsed: 3});

    populateCacheMetadataInResponse(llmResponse, metadata);

    expect(llmResponse.cacheMetadata).toEqual(metadata);
    expect(llmResponse.cacheMetadata).not.toBe(metadata);
    expect(llmResponse.usageMetadata?.cachedContentTokenCount).toBe(500);
  });

  it('works on a response that carries no usage metadata', () => {
    const llmResponse: LlmResponse = {};

    populateCacheMetadataInResponse(llmResponse, activeMetadata());

    expect(llmResponse.cacheMetadata?.cacheName).toBe(CACHE_NAME);
  });
});

describe('GeminiContextCacheManager.handleContextCaching', () => {
  let client: FakeClient;
  let manager: GeminiContextCacheManager;

  beforeEach(() => {
    client = createFakeClient({name: CACHE_NAME});
    manager = new GeminiContextCacheManager(client, GEMINI_SCOPE);
  });

  it('rejects a request that carries no model name', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.model = undefined;

    await expect(manager.handleContextCaching(llmRequest)).rejects.toThrow(
      /model name/,
    );
  });

  it('rejects a request that carries no cache configuration', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheConfig = undefined;

    await expect(manager.handleContextCaching(llmRequest)).rejects.toThrow(
      /cache configuration/,
    );
  });

  it('fingerprints the prefix without creating a cache on the first turn', async () => {
    const llmRequest = createLlmRequest({
      contents: [userContent('a'), modelContent('b'), userContent('c')],
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBeUndefined();
    expect(metadata.contentsCount).toBe(2);
    expect(client.caches.create).not.toHaveBeenCalled();
    expect(llmRequest.config?.cachedContent).toBeUndefined();
  });

  it('reuses a valid cache and returns a copy of its metadata', async () => {
    const llmRequest = createLlmRequest({contentsCount: 3});
    const fingerprint = await generateCacheFingerprint(
      llmRequest,
      3,
      GEMINI_SCOPE,
    );
    const existing = activeMetadata({fingerprint, contentsCount: 3});
    llmRequest.cacheMetadata = existing;

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata).toEqual(existing);
    expect(metadata).not.toBe(existing);
    expect(client.caches.create).not.toHaveBeenCalled();
    expect(client.caches.delete).not.toHaveBeenCalled();
    expect(llmRequest.config?.cachedContent).toBe(CACHE_NAME);
    expect(llmRequest.contents).toEqual([userContent('Test message 2')]);
  });

  it('keeps the final content when a reused cache covers the request', async () => {
    const onlyUser = userContent('Plan the next step');
    const llmRequest = createLlmRequest({contents: [onlyUser]});
    const fingerprint = await generateCacheFingerprint(
      llmRequest,
      1,
      GEMINI_SCOPE,
    );
    llmRequest.cacheMetadata = activeMetadata({fingerprint, contentsCount: 1});

    await manager.handleContextCaching(llmRequest);

    expect(llmRequest.contents).toEqual([onlyUser]);
    expect(llmRequest.config?.cachedContent).toBe(CACHE_NAME);
  });

  it('replaces an invalid cache whose fingerprint still matches', async () => {
    const first = userContent('First question');
    const answer = modelContent('First answer');
    const next = userContent('Next question');
    const priorRequest = createLlmRequest({contents: [first]});
    const priorMetadata = await manager.handleContextCaching(priorRequest);

    const llmRequest = createLlmRequest({
      contents: [first, answer, next],
      cacheMetadata: {
        ...priorMetadata,
        cacheName: CACHE_NAME,
        expireTime: Date.now() / 1000 - 300,
        invocationsUsed: 1,
      },
      cacheableContentsTokenCount: 30000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(client.caches.delete).toHaveBeenCalledExactlyOnceWith({
      name: CACHE_NAME,
    });
    expect(client.caches.create).toHaveBeenCalledOnce();
    expect(metadata.cacheName).toBe(CACHE_NAME);
    expect(metadata.contentsCount).toBe(2);
    expect(createdCacheConfig(client).contents).toEqual([first, answer]);
    expect(llmRequest.contents).toEqual([next]);
  });

  it('keeps the final content when a new cache covers the request', async () => {
    const first = userContent('First question');
    const answer = modelContent('First answer');
    const priorRequest = createLlmRequest({contents: [first]});
    const priorMetadata = await manager.handleContextCaching(priorRequest);

    const llmRequest = createLlmRequest({
      contents: [first, answer],
      cacheMetadata: priorMetadata,
      cacheableContentsTokenCount: 30000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.contentsCount).toBe(2);
    expect(llmRequest.contents).toEqual([answer]);
  });

  it('starts a new chain when the fingerprint no longer matches', async () => {
    const llmRequest = createLlmRequest({
      contents: [userContent('a'), modelContent('b'), userContent('c')],
      cacheMetadata: activeMetadata({
        invocationsUsed: 15,
        contentsCount: 3,
      }),
      cacheableContentsTokenCount: 30000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBeUndefined();
    expect(metadata.contentsCount).toBe(2);
    expect(client.caches.create).not.toHaveBeenCalled();
    expect(client.caches.delete).toHaveBeenCalledOnce();
  });

  it('does not delete anything when the previous metadata has no cache', async () => {
    const llmRequest = createLlmRequest({
      cacheMetadata: {fingerprint: 'stale', contentsCount: 3},
    });

    await manager.handleContextCaching(llmRequest);

    expect(client.caches.delete).not.toHaveBeenCalled();
  });

  it('promotes fingerprint-only metadata to an active cache', async () => {
    const llmRequest = createLlmRequest({
      contentsCount: 0,
      contents: [userContent('a'), modelContent('b')],
      cacheableContentsTokenCount: 30000,
    });
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE),
      contentsCount: 2,
    };

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBe(CACHE_NAME);
    expect(metadata.invocationsUsed).toBe(1);
    expect(client.caches.delete).not.toHaveBeenCalled();
  });
});

describe('GeminiContextCacheManager cache creation gates', () => {
  async function stalePrefixRequest(options: RequestOptions): Promise<{
    client: FakeClient;
    llmRequest: LlmRequest;
    manager: GeminiContextCacheManager;
  }> {
    const client = createFakeClient({name: CACHE_NAME});
    const manager = new GeminiContextCacheManager(client, GEMINI_SCOPE);
    const llmRequest = createLlmRequest(options);
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(
        llmRequest,
        findCountOfContentsToCache(llmRequest.contents),
        GEMINI_SCOPE,
      ),
      contentsCount: findCountOfContentsToCache(llmRequest.contents),
    };
    return {client, llmRequest, manager};
  }

  it('creates a cache for gemini-2.5 above its 2048-token floor', async () => {
    const {client, llmRequest, manager} = await stalePrefixRequest({
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12000),
      cacheableContentsTokenCount: 3000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBe(CACHE_NAME);
    expect(client.caches.create).toHaveBeenCalledOnce();
  });

  it('skips the cache for gemini-3 below its 4096-token floor', async () => {
    const {client, llmRequest, manager} = await stalePrefixRequest({
      model: 'gemini-3.1-pro-preview',
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12000),
      cacheableContentsTokenCount: 3000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBeUndefined();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('applies no client-side floor to an opaque endpoint id', async () => {
    const {client, llmRequest, manager} = await stalePrefixRequest({
      model: 'projects/test/locations/us-central1/endpoints/tuned-model',
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12000),
      cacheableContentsTokenCount: 3000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBe(CACHE_NAME);
    expect(client.caches.create).toHaveBeenCalledOnce();
  });

  it('gates on the cacheable prefix rather than the whole prompt', async () => {
    // A tiny cacheable prefix followed by a huge live user turn: the previous
    // prompt clears the floor while the prefix is far below it.
    const client = createFakeClient({name: CACHE_NAME});
    const manager = new GeminiContextCacheManager(client, GEMINI_SCOPE);
    const llmRequest = createLlmRequest({
      contents: [
        userContent('Short prefix.'),
        userContent('word '.repeat(100000)),
      ],
      systemInstruction: 'You are a helpful assistant.',
      cacheableContentsTokenCount: 75000,
    });
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 1, GEMINI_SCOPE),
      contentsCount: 1,
    };

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBeUndefined();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('skips the cache when no previous token count is known', async () => {
    const {client, llmRequest, manager} = await stalePrefixRequest({
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12000),
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBeUndefined();
    expect(metadata.contentsCount).toBe(2);
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('skips the cache when the previous prompt was below minTokens', async () => {
    const {client, llmRequest, manager} = await stalePrefixRequest({
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12000),
      cacheConfig: {...CACHE_CONFIG, minTokens: 10000},
      cacheableContentsTokenCount: 3000,
    });

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBeUndefined();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('keeps the grown prefix when the service rejects the cache', async () => {
    const {client, llmRequest, manager} = await stalePrefixRequest({
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12000),
      cacheableContentsTokenCount: 3000,
    });
    client.caches.create.mockRejectedValue(new Error('400 INVALID_ARGUMENT'));

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBeUndefined();
    expect(metadata.contentsCount).toBe(2);
    expect(llmRequest.config?.cachedContent).toBeUndefined();
  });

  it('keeps the grown prefix when the service returns no cache name', async () => {
    const {client, llmRequest, manager} = await stalePrefixRequest({
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12000),
      cacheableContentsTokenCount: 3000,
    });
    client.caches.create.mockResolvedValue({});

    const metadata = await manager.handleContextCaching(llmRequest);

    expect(metadata.cacheName).toBeUndefined();
    expect(metadata.contentsCount).toBe(2);
  });
});

describe('GeminiContextCacheManager cache creation request', () => {
  async function createCache(
    cachedContent: CachedContent,
    cacheConfig: ContextCacheConfig = CACHE_CONFIG,
  ): Promise<{client: FakeClient; metadata: CacheMetadata}> {
    const client = createFakeClient(cachedContent);
    const manager = new GeminiContextCacheManager(client, GEMINI_SCOPE);
    const llmRequest = createLlmRequest({
      contents: [userContent('a'), modelContent('b')],
      systemInstruction: 'x'.repeat(12000),
      cacheConfig,
      cacheableContentsTokenCount: 3000,
    });
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE),
      contentsCount: 2,
    };
    return {client, metadata: await manager.handleContextCaching(llmRequest)};
  }

  it('records the cache it created on a create_cache span', async () => {
    exporter.reset();

    await createCache({name: CACHE_NAME});

    const [span] = exporter
      .getFinishedSpans()
      .filter((finished) => finished.name === 'create_cache');
    expect(span.attributes).toMatchObject({
      cache_contents_count: 2,
      model: 'gemini-2.5-flash',
      ttl_seconds: 1800,
      cache_name: CACHE_NAME,
    });
  });

  it('sends the ttl, the display name, the tools and the tool config', async () => {
    const {client} = await createCache({name: CACHE_NAME});

    const config = createdCacheConfig(client);
    expect(config.ttl).toBe('1800s');
    expect(config.displayName).toMatch(/^adk-cache-\d+-2contents$/);
    expect(config.tools).toEqual(TOOLS);
    expect(config.toolConfig).toEqual(TOOL_CONFIG);
    expect(config.systemInstruction).toBe('x'.repeat(12000));
    expect(config.httpOptions).toBeUndefined();
  });

  it('passes the cache-creation http options through', async () => {
    const {client} = await createCache(
      {name: CACHE_NAME},
      {...CACHE_CONFIG, createHttpOptions: {timeout: 10000}},
    );

    expect(createdCacheConfig(client).httpOptions).toEqual({timeout: 10000});
  });

  it('prefers the expiry the service reports', async () => {
    const {metadata} = await createCache({
      name: CACHE_NAME,
      expireTime: '2033-05-18T03:33:20Z',
    });

    expect(metadata.expireTime).toBe(2000000000);
  });

  it('falls back to the ttl when the reported expiry does not parse', async () => {
    const before = Date.now() / 1000;

    const {metadata} = await createCache({
      name: CACHE_NAME,
      expireTime: 'not-a-timestamp',
    });

    expect(metadata.expireTime).toBeGreaterThanOrEqual(before + 1800);
  });

  it('falls back to the ttl when the service reports no expiry', async () => {
    const before = Date.now() / 1000;

    const {metadata} = await createCache({name: CACHE_NAME});

    expect(metadata.expireTime).toBeGreaterThanOrEqual(before + 1800);
  });
});

describe('GeminiContextCacheManager.cleanupCache', () => {
  it('deletes the cache by name', async () => {
    const client = createFakeClient();
    const manager = new GeminiContextCacheManager(client, GEMINI_SCOPE);

    await manager.cleanupCache(CACHE_NAME);

    expect(client.caches.delete).toHaveBeenCalledExactlyOnceWith({
      name: CACHE_NAME,
    });
  });

  it('swallows a failed deletion', async () => {
    const client = createFakeClient();
    client.caches.delete.mockRejectedValue(new Error('404 NOT_FOUND'));
    const manager = new GeminiContextCacheManager(client, GEMINI_SCOPE);

    await expect(manager.cleanupCache(CACHE_NAME)).resolves.toBeUndefined();
  });
});

describe('cache scope isolation', () => {
  it('gives the same request different identities on two backends', async () => {
    const llmRequest = createLlmRequest();

    expect(await fingerprintOf(llmRequest, GEMINI_SCOPE)).not.toBe(
      await fingerprintOf(createLlmRequest(), VERTEX_SCOPE),
    );
  });
});
