/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Edge cases the ported adk-python suite does not reach. The ported tests live
 * in `gemini_context_cache_manager_test.ts` and keep their Python names.
 */

import {
  CachedContent,
  CallableTool,
  Content,
  CreateCachedContentParameters,
  DeleteCachedContentParameters,
  DeleteCachedContentResponse,
  Tool,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ContextCacheConfig} from '../../src/agents/context_cache_config.js';
import {
  CacheScope,
  GeminiContextCacheManager,
  QualifiedCacheScope,
  applyCacheToRequest,
  estimateCacheablePrefixTokens,
  estimateRequestTokens,
  findCountOfContentsToCache,
  generateCacheFingerprint,
  minimumCacheTokens,
  validActiveCache,
} from '../../src/models/gemini_context_cache_manager.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 0,
};

const GEMINI_SCOPE: QualifiedCacheScope = {backend: 'gemini'};
const VERTEX_SCOPE: QualifiedCacheScope = {backend: 'vertex'};

type CacheClientSlice = ConstructorParameters<
  typeof GeminiContextCacheManager
>[0];

interface FakeClient {
  client: CacheClientSlice;
  create: ReturnType<typeof createCacheMock>;
  remove: ReturnType<typeof removeCacheMock>;
}

function createCacheMock() {
  return vi.fn<
    (params: CreateCachedContentParameters) => Promise<CachedContent>
  >(async () => ({name: 'cachedContents/created'}));
}

function removeCacheMock() {
  return vi.fn<
    (
      params: DeleteCachedContentParameters,
    ) => Promise<DeleteCachedContentResponse>
  >(async () => ({}));
}

function createFakeClient(vertexai = false): FakeClient {
  const create = createCacheMock();
  const remove = removeCacheMock();
  return {client: {vertexai, caches: {create, delete: remove}}, create, remove};
}

function userContent(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelContent(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

/** A request whose cacheable prefix is large enough to clear every floor. */
function largePrefixRequest(): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents: [],
    config: {systemInstruction: 'x'.repeat(40000)},
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: CACHE_CONFIG,
    cacheableContentsTokenCount: 10000,
  };
}

/** Gives the request metadata that matches its own cacheable prefix. */
async function withMatchingFingerprint(
  llmRequest: LlmRequest,
  contentsCount: number,
  scope: QualifiedCacheScope = GEMINI_SCOPE,
): Promise<LlmRequest> {
  llmRequest.cacheMetadata = {
    fingerprint: await generateCacheFingerprint(
      llmRequest,
      contentsCount,
      scope,
    ),
    contentsCount,
  };
  return llmRequest;
}

describe('findCountOfContentsToCache', () => {
  it('returns zero for an empty content list', () => {
    expect(findCountOfContentsToCache([])).toBe(0);
  });

  it('returns zero when every content is a user content', () => {
    expect(
      findCountOfContentsToCache([userContent('a'), userContent('b')]),
    ).toBe(0);
  });

  it('returns the length when the last content is not a user content', () => {
    expect(
      findCountOfContentsToCache([userContent('a'), modelContent('b')]),
    ).toBe(2);
  });
});

describe('minimumCacheTokens', () => {
  it('reads the family from the last segment of a model resource path', () => {
    expect(
      minimumCacheTokens(
        'projects/p/locations/l/publishers/google/models/gemini-2.5-flash',
      ),
    ).toBe(2048);
  });

  it('applies the Gemini 3 floor', () => {
    expect(minimumCacheTokens('gemini-3-pro-preview')).toBe(4096);
  });

  it('leaves the server authoritative for an unnamed model', () => {
    expect(minimumCacheTokens('some-other-model')).toBeUndefined();
  });

  it('leaves the server authoritative when no model is given', () => {
    expect(minimumCacheTokens()).toBeUndefined();
  });
});

describe('estimateRequestTokens', () => {
  function requestWith(config: LlmRequest['config']): LlmRequest {
    return {
      model: 'gemini-2.5-flash',
      contents: [],
      config,
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };
  }

  it('counts a string system instruction at four characters per token', () => {
    expect(requestTokensOf('x'.repeat(400))).toBe(100);
  });

  function requestTokensOf(systemInstruction: string): number {
    return estimateRequestTokens(requestWith({systemInstruction}));
  }

  it('counts every string in a system instruction array', () => {
    expect(
      estimateRequestTokens(
        requestWith({systemInstruction: ['x'.repeat(200), 'y'.repeat(200)]}),
      ),
    ).toBe(100);
  });

  it('counts a part in a system instruction array by its serialized form', () => {
    const mixed = estimateRequestTokens(
      requestWith({systemInstruction: ['x'.repeat(200), {text: 'hello'}]}),
    );
    const stringOnly = estimateRequestTokens(
      requestWith({systemInstruction: ['x'.repeat(200)]}),
    );

    expect(mixed).toBeGreaterThan(stringOnly);
  });

  it('counts a structured system instruction by its serialized form', () => {
    const structured = estimateRequestTokens(
      requestWith({
        systemInstruction: {role: 'user', parts: [{text: 'hello'}]},
      }),
    );

    expect(structured).toBeGreaterThan(0);
  });

  it('counts a declarative tool and skips a callable tool', () => {
    const declarative: Tool = {
      functionDeclarations: [{name: 'lookup', description: 'd'}],
    };
    const callable: CallableTool = {
      tool: async () => declarative,
      callTool: async () => [],
    };

    const withCallable = estimateRequestTokens(
      requestWith({tools: [declarative, callable]}),
    );
    const withoutCallable = estimateRequestTokens(
      requestWith({tools: [declarative]}),
    );

    expect(withCallable).toBe(withoutCallable);
    expect(withCallable).toBeGreaterThan(0);
  });

  it('ignores a part that carries no text', () => {
    const llmRequest = requestWith({});
    llmRequest.contents = [{role: 'user', parts: [{inlineData: {data: 'AA'}}]}];

    expect(estimateRequestTokens(llmRequest)).toBe(0);
  });

  it('ignores a content that carries no parts', () => {
    const llmRequest = requestWith({});
    llmRequest.contents = [{role: 'user'}];

    expect(estimateRequestTokens(llmRequest)).toBe(0);
  });
});

describe('estimateCacheablePrefixTokens', () => {
  it('returns zero when no token count was measured', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('hello')],
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(0);
  });

  it('returns the measured count when the request holds no text', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [{role: 'user', parts: [{inlineData: {data: 'AA'}}]}],
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
      cacheableContentsTokenCount: 5000,
    };

    expect(estimateRequestTokens(llmRequest)).toBe(0);
    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(5000);
  });

  it('scales the measured count by the prefix share of the request', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('a'.repeat(400)), userContent('b'.repeat(400))],
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
      cacheableContentsTokenCount: 1000,
    };

    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(500);
  });
});

describe('applyCacheToRequest', () => {
  it('creates the config when the request has none', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('a'), userContent('b')],
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    applyCacheToRequest(llmRequest, 'cachedContents/x', 1);

    expect(llmRequest.config?.cachedContent).toBe('cachedContents/x');
    expect(llmRequest.contents).toEqual([userContent('b')]);
  });

  it('clears the fields that moved into the cache', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('a')],
      config: {
        systemInstruction: 'be helpful',
        tools: [{functionDeclarations: [{name: 'lookup'}]}],
        toolConfig: {functionCallingConfig: {}},
      },
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    applyCacheToRequest(llmRequest, 'cachedContents/x', 1);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.config?.tools).toBeUndefined();
    expect(llmRequest.config?.toolConfig).toBeUndefined();
  });
});

describe('generateCacheFingerprint', () => {
  it('separates the Vertex and Gemini backends', async () => {
    const llmRequest = largePrefixRequest();

    expect(
      await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    ).not.toBe(await generateCacheFingerprint(llmRequest, 0, VERTEX_SCOPE));
  });

  it('separates two Vertex projects', async () => {
    const llmRequest = largePrefixRequest();

    expect(
      await generateCacheFingerprint(llmRequest, 0, {
        ...VERTEX_SCOPE,
        project: 'one',
      }),
    ).not.toBe(
      await generateCacheFingerprint(llmRequest, 0, {
        ...VERTEX_SCOPE,
        project: 'two',
      }),
    );
  });

  it('separates two base URLs', async () => {
    const llmRequest = largePrefixRequest();

    expect(
      await generateCacheFingerprint(llmRequest, 0, {
        ...GEMINI_SCOPE,
        baseUrl: 'https://one.example.com',
      }),
    ).not.toBe(
      await generateCacheFingerprint(llmRequest, 0, {
        ...GEMINI_SCOPE,
        baseUrl: 'https://two.example.com',
      }),
    );
  });

  it('accepts a tool that declares no functions', async () => {
    const llmRequest = largePrefixRequest();
    llmRequest.config = {...llmRequest.config, tools: [{googleSearch: {}}]};

    expect(await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    );
  });

  it('ignores a callable tool, which a cache cannot hold', async () => {
    const declarative: Tool = {functionDeclarations: [{name: 'lookup'}]};
    const callable: CallableTool = {
      tool: async () => declarative,
      callTool: async () => [],
    };
    const withCallable = largePrefixRequest();
    withCallable.config = {
      ...withCallable.config,
      tools: [declarative, callable],
    };
    const withoutCallable = largePrefixRequest();
    withoutCallable.config = {...withoutCallable.config, tools: [declarative]};

    expect(await generateCacheFingerprint(withCallable, 0, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(withoutCallable, 0, GEMINI_SCOPE),
    );
  });

  it('caps the cached prefix at the number of contents present', async () => {
    const llmRequest = largePrefixRequest();
    llmRequest.contents = [userContent('a'), modelContent('b')];

    expect(await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(llmRequest, 99, GEMINI_SCOPE),
    );
  });
});

describe('validActiveCache', () => {
  it('returns undefined when the request carries no metadata', async () => {
    const llmRequest = largePrefixRequest();

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('reuses a cache whose use count equals the interval budget', async () => {
    const llmRequest = largePrefixRequest();
    const cacheMetadata = {
      cacheName: 'cachedContents/x',
      expireTime: Date.now() / 1000 + 60,
      invocationsUsed: CACHE_CONFIG.cacheIntervals,
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };
    llmRequest.cacheMetadata = cacheMetadata;

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toEqual(
      cacheMetadata,
    );
  });

  it('rejects a cache one use past the interval budget', async () => {
    const llmRequest = largePrefixRequest();
    llmRequest.cacheMetadata = {
      cacheName: 'cachedContents/x',
      expireTime: Date.now() / 1000 + 60,
      invocationsUsed: CACHE_CONFIG.cacheIntervals + 1,
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('rejects a cache at the instant it expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    try {
      const llmRequest = largePrefixRequest();
      llmRequest.cacheMetadata = {
        cacheName: 'cachedContents/x',
        expireTime: Date.now() / 1000,
        invocationsUsed: 1,
        fingerprint: await generateCacheFingerprint(
          llmRequest,
          0,
          GEMINI_SCOPE,
        ),
        contentsCount: 0,
      };

      expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when an active cache has no cache configuration', async () => {
    const llmRequest = largePrefixRequest();
    llmRequest.cacheConfig = undefined;
    llmRequest.cacheMetadata = {
      cacheName: 'cachedContents/x',
      expireTime: Date.now() / 1000 + 60,
      invocationsUsed: 1,
      fingerprint: 'anything',
      contentsCount: 0,
    };

    await expect(validActiveCache(llmRequest, GEMINI_SCOPE)).rejects.toThrow(
      /cache configuration/,
    );
  });
});

describe('populateCacheMetadataInResponse', () => {
  it('copies the metadata rather than aliasing it', () => {
    const manager = new GeminiContextCacheManager(createFakeClient().client);
    const llmResponse: LlmResponse = {};
    const cacheMetadata = {fingerprint: 'abc', contentsCount: 2};

    manager.populateCacheMetadataInResponse(llmResponse, cacheMetadata);

    expect(llmResponse.cacheMetadata).toEqual(cacheMetadata);
    expect(llmResponse.cacheMetadata).not.toBe(cacheMetadata);
  });
});

describe('GeminiContextCacheManager cache failures', () => {
  let fake: FakeClient;
  let manager: GeminiContextCacheManager;

  beforeEach(() => {
    fake = createFakeClient();
    manager = new GeminiContextCacheManager(fake.client);
  });

  it('swallows a rejected delete', async () => {
    fake.remove.mockRejectedValue(new Error('network down'));

    await expect(
      manager.cleanupCache('cachedContents/x'),
    ).resolves.toBeUndefined();
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it('degrades to fingerprint-only metadata when creation rejects', async () => {
    const llmRequest = await withMatchingFingerprint(largePrefixRequest(), 0);
    fake.create.mockRejectedValue(new Error('service unavailable'));

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.contentsCount).toBe(0);
    expect(llmRequest.config?.cachedContent).toBeUndefined();
  });

  it('degrades to fingerprint-only metadata when the server returns no name', async () => {
    const llmRequest = await withMatchingFingerprint(largePrefixRequest(), 0);
    fake.create.mockResolvedValue({});

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(llmRequest.config?.cachedContent).toBeUndefined();
  });

  it('skips creation when the measured prompt is below minTokens', async () => {
    const llmRequest = largePrefixRequest();
    llmRequest.cacheConfig = {...CACHE_CONFIG, minTokens: 20000};
    await withMatchingFingerprint(llmRequest, 0);

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('falls back to the configured ttl when the server expiry is unparsable', async () => {
    const llmRequest = await withMatchingFingerprint(largePrefixRequest(), 0);
    fake.create.mockResolvedValue({
      name: 'cachedContents/x',
      expireTime: 'not-a-timestamp',
    });
    const before = Date.now() / 1000;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.expireTime).toBeGreaterThanOrEqual(
      before + CACHE_CONFIG.ttlSeconds,
    );
    expect(result.createdAt).toBeGreaterThanOrEqual(before);
  });
});

describe('GeminiContextCacheManager cache scope', () => {
  it('drops the project and location on the Gemini backend', async () => {
    const bare = createFakeClient();
    const scoped = createFakeClient();
    const scope: CacheScope = {project: 'p', location: 'l'};
    const bareManager = new GeminiContextCacheManager(bare.client);
    const scopedManager = new GeminiContextCacheManager(scoped.client, scope);

    const bareResult =
      await bareManager.handleContextCaching(largePrefixRequest());
    const scopedResult =
      await scopedManager.handleContextCaching(largePrefixRequest());

    expect(scopedResult.fingerprint).toBe(bareResult.fingerprint);
  });

  it('keeps the project and location on the Vertex backend', async () => {
    const bare = createFakeClient(true);
    const scoped = createFakeClient(true);
    const bareManager = new GeminiContextCacheManager(bare.client);
    const scopedManager = new GeminiContextCacheManager(scoped.client, {
      project: 'p',
      location: 'l',
    });

    const bareResult =
      await bareManager.handleContextCaching(largePrefixRequest());
    const scopedResult =
      await scopedManager.handleContextCaching(largePrefixRequest());

    expect(scopedResult.fingerprint).not.toBe(bareResult.fingerprint);
  });

  it('keeps the base URL on either backend', async () => {
    const bare = createFakeClient();
    const scoped = createFakeClient();
    const bareManager = new GeminiContextCacheManager(bare.client);
    const scopedManager = new GeminiContextCacheManager(scoped.client, {
      baseUrl: 'https://proxy.example.com',
    });

    const bareResult =
      await bareManager.handleContextCaching(largePrefixRequest());
    const scopedResult =
      await scopedManager.handleContextCaching(largePrefixRequest());

    expect(scopedResult.fingerprint).not.toBe(bareResult.fingerprint);
  });
});
