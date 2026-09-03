/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `adk-python`
 * `tests/unittests/agents/test_gemini_context_cache_manager.py`, read at
 * commit 8e30a30884cb9355c711695f446fb2db6e94e2c1. Each `it(...)` keeps the
 * Python test name verbatim, so a reader can find the original.
 */

import {
  ActiveCacheMetadata,
  CacheClient,
  CacheMetadata,
  ContextCacheConfig,
  GeminiContextCacheManager,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  CachedContent,
  Content,
  CreateCachedContentConfig,
  CreateCachedContentParameters,
  DeleteCachedContentParameters,
  DeleteCachedContentResponse,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  Tool,
  ToolConfig,
  Type,
} from '@google/genai';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  applyCacheToRequest,
  estimateCacheablePrefixTokens,
  estimateRequestTokens,
  findCountOfContentsToCache,
  generateCacheFingerprint,
  minimumCacheTokens,
  QualifiedCacheScope,
  validActiveCache,
} from '../../src/models/gemini_context_cache_manager.js';

const GEMINI_SCOPE: QualifiedCacheScope = {backend: 'gemini'};
const VERTEX_SCOPE: QualifiedCacheScope = {backend: 'vertex'};

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 0,
};

interface FakeClient extends CacheClient {
  readonly caches: {
    create: Mock<
      (params: CreateCachedContentParameters) => Promise<CachedContent>
    >;
    delete: Mock<
      (
        params: DeleteCachedContentParameters,
      ) => Promise<DeleteCachedContentResponse>
    >;
  };
}

function createClient(vertexai = false): FakeClient {
  return {
    vertexai,
    caches: {
      create: vi.fn(async () => ({name: 'cachedContents/default'})),
      delete: vi.fn(async () => ({})),
    },
  };
}

/** Returns the `config` the fake client last received on `caches.create`. */
function lastCreateConfig(client: FakeClient): CreateCachedContentConfig {
  const call = client.caches.create.mock.calls.at(-1);
  if (!call) {
    expect.fail('caches.create was never called.');
  }
  const config = call[0].config;
  if (!config) {
    expect.fail('caches.create was called without a config.');
  }
  return config;
}

function userContent(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelContent(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

const TEST_TOOLS: Tool[] = [
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

const TEST_TOOL_CONFIG: ToolConfig = {
  functionCallingConfig: {mode: FunctionCallingConfigMode.AUTO},
};

function createLlmRequest(
  cacheMetadata?: CacheMetadata,
  contentsCount = 3,
): LlmRequest {
  const contents: Content[] = [];
  for (let index = 0; index < contentsCount; index++) {
    contents.push(userContent(`Test message ${index}`));
  }
  return {
    model: 'gemini-2.5-flash',
    contents,
    config: {
      systemInstruction: 'Test instruction',
      tools: structuredClone(TEST_TOOLS),
      toolConfig: structuredClone(TEST_TOOL_CONFIG),
    },
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: CACHE_CONFIG,
    cacheMetadata,
  };
}

function createCacheMetadata(
  invocationsUsed = 0,
  expired = false,
  contentsCount = 3,
): ActiveCacheMetadata {
  const now = Date.now() / 1000;
  return {
    cacheName: 'projects/test/locations/us-central1/cachedContents/test123',
    expireTime: expired ? now - 300 : now + 1800,
    fingerprint: 'test_fingerprint',
    invocationsUsed,
    contentsCount,
    createdAt: now - 600,
  };
}

/**
 * Replaces the metadata's fingerprint with the one the manager computes over
 * `contentsCount`, so the reuse and refresh paths run on real fingerprints
 * instead of a patched private method.
 */
async function withRealFingerprint<T extends CacheMetadata>(
  metadata: T,
  llmRequest: LlmRequest,
  scope: QualifiedCacheScope = GEMINI_SCOPE,
): Promise<T> {
  return {
    ...metadata,
    fingerprint: await generateCacheFingerprint(
      llmRequest,
      metadata.contentsCount,
      scope,
    ),
  };
}

describe('GeminiContextCacheManager', () => {
  let client: FakeClient;
  let manager: GeminiContextCacheManager;

  beforeEach(() => {
    client = createClient();
    manager = new GeminiContextCacheManager(client);
  });

  it('test_init', () => {
    const freshClient = createClient();

    expect(new GeminiContextCacheManager(freshClient)).toBeInstanceOf(
      GeminiContextCacheManager,
    );
  });

  it('test_handle_context_caching_no_existing_cache', async () => {
    const llmRequest = createLlmRequest(undefined, 5);

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.expireTime).toBeUndefined();
    expect(result.invocationsUsed).toBeUndefined();
    expect(result.createdAt).toBeUndefined();
    expect(result.fingerprint).toEqual(
      await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    );
    expect(result.contentsCount).toBe(0);
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('test_handle_context_caching_valid_existing_cache', async () => {
    const llmRequest = createLlmRequest(createCacheMetadata(5));
    const existingCache = await withRealFingerprint(
      createCacheMetadata(5),
      llmRequest,
    );
    llmRequest.cacheMetadata = existingCache;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBe(existingCache.cacheName);
    expect(result.invocationsUsed).toBe(existingCache.invocationsUsed);
    expect(result.expireTime).toBe(existingCache.expireTime);
    expect(result.fingerprint).toBe(existingCache.fingerprint);
    expect(result.createdAt).toBe(existingCache.createdAt);
    expect(result).not.toBe(existingCache);
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('test_handle_context_caching_invalid_cache_fingerprint_match', async () => {
    client.caches.create.mockResolvedValue({
      name: 'projects/test/locations/us-central1/cachedContents/new456',
    });
    // invocationsUsed exceeds cacheIntervals, so the cache is invalid.
    const llmRequest = createLlmRequest(createCacheMetadata(15));
    llmRequest.cacheMetadata = await withRealFingerprint(
      createCacheMetadata(15),
      llmRequest,
    );
    llmRequest.cacheableContentsTokenCount = 5000;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBe(
      'projects/test/locations/us-central1/cachedContents/new456',
    );
    expect(client.caches.delete).toHaveBeenCalledTimes(1);
    expect(client.caches.delete).toHaveBeenCalledWith({
      name: 'projects/test/locations/us-central1/cachedContents/test123',
    });
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  it('test_model_change_invalidates_active_cache', async () => {
    const flashRequest = createLlmRequest(undefined, 0);
    const flashMetadata = await manager.handleContextCaching(flashRequest);
    const activeMetadata: ActiveCacheMetadata = {
      cacheName: 'cachedContents/flash-cache',
      expireTime: Date.now() / 1000 + 1800,
      fingerprint: flashMetadata.fingerprint,
      invocationsUsed: 1,
      contentsCount: flashMetadata.contentsCount,
      createdAt: Date.now() / 1000,
    };
    const proRequest = createLlmRequest(activeMetadata, 0);
    proRequest.model = 'gemini-2.5-pro';

    const proMetadata = await manager.handleContextCaching(proRequest);

    expect(proMetadata.cacheName).toBeUndefined();
    expect(proMetadata.fingerprint).not.toBe(activeMetadata.fingerprint);
    expect(client.caches.delete).toHaveBeenCalledTimes(1);
    expect(client.caches.delete).toHaveBeenCalledWith({
      name: 'cachedContents/flash-cache',
    });
  });

  it('test_backend_change_invalidates_active_cache', async () => {
    const developerRequest = createLlmRequest(undefined, 0);
    const developerMetadata =
      await manager.handleContextCaching(developerRequest);
    const activeMetadata: ActiveCacheMetadata = {
      cacheName: 'cachedContents/developer-cache',
      expireTime: Date.now() / 1000 + 1800,
      fingerprint: developerMetadata.fingerprint,
      invocationsUsed: 1,
      contentsCount: developerMetadata.contentsCount,
      createdAt: Date.now() / 1000,
    };
    const vertexClient = createClient(true);
    const vertexManager = new GeminiContextCacheManager(vertexClient);
    const vertexRequest = createLlmRequest(activeMetadata, 0);

    const vertexMetadata =
      await vertexManager.handleContextCaching(vertexRequest);

    expect(vertexMetadata.cacheName).toBeUndefined();
    expect(vertexMetadata.fingerprint).not.toBe(activeMetadata.fingerprint);
    expect(vertexClient.caches.delete).toHaveBeenCalledTimes(1);
    expect(vertexClient.caches.delete).toHaveBeenCalledWith({
      name: 'cachedContents/developer-cache',
    });
  });

  it('test_create_cache_gates_on_prefix_not_full_prompt', async () => {
    const contents = [
      userContent('Short prefix.'),
      userContent('word '.repeat(100_000)),
    ];
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents,
      config: {systemInstruction: 'You are a helpful assistant.'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
      // The whole previous prompt is large, but only the tiny first content
      // is cacheable.
      cacheableContentsTokenCount: 75000,
    };
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 1, GEMINI_SCOPE),
      contentsCount: 1,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('test_completed_turn_grows_cacheable_prefix', async () => {
    const firstUser = userContent('First question');
    const firstModel = modelContent('First answer');
    const nextUser = userContent('Next question');
    const firstRequest = createLlmRequest(undefined, 0);
    firstRequest.contents = [firstUser];

    const firstMetadata = await manager.handleContextCaching(firstRequest);

    expect(firstMetadata.contentsCount).toBe(0);

    const nextRequest = createLlmRequest(firstMetadata, 0);
    nextRequest.contents = [firstUser, firstModel, nextUser];
    nextRequest.cacheableContentsTokenCount = 30_000;
    client.caches.create.mockResolvedValue({
      name: 'cachedContents/grown-prefix',
    });

    const nextMetadata = await manager.handleContextCaching(nextRequest);

    expect(nextMetadata.cacheName).toBe('cachedContents/grown-prefix');
    expect(nextMetadata.contentsCount).toBe(2);
    expect(lastCreateConfig(client).contents).toEqual([firstUser, firstModel]);
    expect(nextRequest.contents).toEqual([nextUser]);
  });

  it('test_cache_reuse_keeps_final_content_in_request', async () => {
    const onlyUser = userContent('Plan the next step');
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.contents = [onlyUser];
    const existingCache = await withRealFingerprint(
      createCacheMetadata(1, false, 1),
      llmRequest,
    );
    llmRequest.cacheMetadata = existingCache;

    await manager.handleContextCaching(llmRequest);

    expect(llmRequest.contents).toEqual([onlyUser]);
    expect(llmRequest.config?.cachedContent).toBe(existingCache.cacheName);
  });

  it('test_cache_creation_keeps_final_content_in_request', async () => {
    const userMsg = userContent('First question');
    const modelMsg = modelContent('First answer');
    const firstRequest = createLlmRequest(undefined, 0);
    firstRequest.contents = [userMsg];

    const firstMetadata = await manager.handleContextCaching(firstRequest);

    const nextRequest = createLlmRequest(firstMetadata, 0);
    nextRequest.contents = [userMsg, modelMsg];
    nextRequest.cacheableContentsTokenCount = 30_000;
    client.caches.create.mockResolvedValue({
      name: 'cachedContents/full-prefix',
    });

    const nextMetadata = await manager.handleContextCaching(nextRequest);

    expect(nextMetadata.contentsCount).toBe(2);
    expect(nextRequest.contents).toEqual([modelMsg]);
  });

  it('test_gemini_25_creates_cache_above_2048_token_minimum', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };
    client.caches.create.mockResolvedValue({name: 'cachedContents/gemini-25'});

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBe('cachedContents/gemini-25');
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  it('test_gemini_3_skips_cache_below_4096_token_minimum', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.model = 'gemini-3.1-pro-preview';
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('test_opaque_model_does_not_apply_guessed_token_minimum', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.model = 'projects/test/locations/us-central1/endpoints/tuned';
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };
    client.caches.create.mockResolvedValue({
      name: 'cachedContents/tuned-model',
    });

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBe('cachedContents/tuned-model');
    expect(client.caches.create).toHaveBeenCalledTimes(1);
  });

  it('test_handle_context_caching_invalid_cache_fingerprint_mismatch', async () => {
    const llmRequest = createLlmRequest(undefined, 5);
    // A fingerprint taken over a different prefix, so the recomputed one at
    // contentsCount=3 cannot match.
    const existingCache: ActiveCacheMetadata = {
      ...createCacheMetadata(15, false, 3),
      fingerprint: await generateCacheFingerprint(
        createLlmRequest(undefined, 1),
        1,
        GEMINI_SCOPE,
      ),
    };
    llmRequest.cacheMetadata = existingCache;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.expireTime).toBeUndefined();
    expect(result.invocationsUsed).toBeUndefined();
    expect(result.createdAt).toBeUndefined();
    expect(result.fingerprint).toBe(
      await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    );
    expect(result.contentsCount).toBe(0);
    expect(client.caches.delete).toHaveBeenCalledTimes(1);
    expect(client.caches.delete).toHaveBeenCalledWith({
      name: existingCache.cacheName,
    });
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('test_is_cache_valid_fingerprint_mismatch', async () => {
    const llmRequest = createLlmRequest(createCacheMetadata());

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('test_is_cache_valid_expired_cache', async () => {
    const llmRequest = createLlmRequest(createCacheMetadata(0, true));
    llmRequest.cacheMetadata = await withRealFingerprint(
      createCacheMetadata(0, true),
      llmRequest,
    );

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('test_is_cache_valid_fingerprint_only_metadata', async () => {
    const llmRequest = createLlmRequest({
      fingerprint: 'test_fingerprint',
      contentsCount: 5,
    });

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('test_is_cache_valid_cache_intervals_exceeded', async () => {
    const llmRequest = createLlmRequest(createCacheMetadata(15));
    llmRequest.cacheMetadata = await withRealFingerprint(
      createCacheMetadata(15),
      llmRequest,
    );

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('test_is_cache_valid_all_checks_pass', async () => {
    const llmRequest = createLlmRequest(createCacheMetadata(5));
    llmRequest.cacheMetadata = await withRealFingerprint(
      createCacheMetadata(5),
      llmRequest,
    );

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeDefined();
  });

  it('test_cleanup_cache', async () => {
    const cacheName =
      'projects/test/locations/us-central1/cachedContents/test123';

    await manager.cleanupCache(cacheName);

    expect(client.caches.delete).toHaveBeenCalledTimes(1);
    expect(client.caches.delete).toHaveBeenCalledWith({name: cacheName});
  });

  it('test_generate_cache_fingerprint', async () => {
    const llmRequest = createLlmRequest();
    const cacheContentsCount = 2;

    const fingerprint1 = await generateCacheFingerprint(
      llmRequest,
      cacheContentsCount,
      GEMINI_SCOPE,
    );
    const fingerprint2 = await generateCacheFingerprint(
      llmRequest,
      cacheContentsCount,
      GEMINI_SCOPE,
    );

    expect(fingerprint1).toBe(fingerprint2);
    expect(fingerprint1.length).toBeGreaterThan(0);

    const requestWithoutTools: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('Test')],
      config: {systemInstruction: 'Test instruction'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(
      await generateCacheFingerprint(
        requestWithoutTools,
        cacheContentsCount,
        GEMINI_SCOPE,
      ),
    ).not.toBe(fingerprint1);
  });

  it('test_generate_cache_fingerprint_different_requests', async () => {
    const llmRequest1 = createLlmRequest();
    const llmRequest2: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('Different message')],
      config: {systemInstruction: 'Different instruction'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(
      await generateCacheFingerprint(llmRequest1, 2, GEMINI_SCOPE),
    ).not.toBe(await generateCacheFingerprint(llmRequest2, 2, GEMINI_SCOPE));
  });

  it('test_generate_cache_fingerprint_canonicalizes_mapping_order', async () => {
    const firstRequest = createLlmRequest(undefined, 0);
    const secondRequest = createLlmRequest(undefined, 0);
    firstRequest.contents = [
      {
        role: 'model',
        parts: [{functionCall: {name: 'lookup', args: {first: 1, second: 2}}}],
      },
    ];
    secondRequest.contents = [
      {
        role: 'model',
        parts: [{functionCall: {name: 'lookup', args: {second: 2, first: 1}}}],
      },
    ];

    expect(await generateCacheFingerprint(firstRequest, 1, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(secondRequest, 1, GEMINI_SCOPE),
    );
  });

  it('test_generate_cache_fingerprint_tool_config_variations', async () => {
    const llmRequestAuto = createLlmRequest();
    const llmRequestNone: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('Test')],
      config: {
        systemInstruction: 'Test instruction',
        tools: llmRequestAuto.config!.tools,
        toolConfig: {
          functionCallingConfig: {mode: FunctionCallingConfigMode.NONE},
        },
      },
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(
      await generateCacheFingerprint(llmRequestAuto, 2, GEMINI_SCOPE),
    ).not.toBe(await generateCacheFingerprint(llmRequestNone, 2, GEMINI_SCOPE));
  });

  it('test_generate_cache_fingerprint_tool_order_independent', async () => {
    const declAlpha: FunctionDeclaration = {name: 'alpha', description: 'a'};
    const declBeta: FunctionDeclaration = {name: 'beta', description: 'b'};
    const content = userContent('Test');

    const buildRequest = (tools: Tool[]): LlmRequest => ({
      model: 'gemini-2.5-flash',
      contents: [content],
      config: {systemInstruction: 'Test instruction', tools},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    });

    const requestAb = buildRequest([
      {functionDeclarations: [declAlpha]},
      {functionDeclarations: [declBeta]},
    ]);
    const requestBa = buildRequest([
      {functionDeclarations: [declBeta]},
      {functionDeclarations: [declAlpha]},
    ]);

    expect(await generateCacheFingerprint(requestAb, 1, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(requestBa, 1, GEMINI_SCOPE),
    );

    const requestDeclsAb = buildRequest([
      {functionDeclarations: [declAlpha, declBeta]},
    ]);
    const requestDeclsBa = buildRequest([
      {functionDeclarations: [declBeta, declAlpha]},
    ]);

    expect(
      await generateCacheFingerprint(requestDeclsAb, 1, GEMINI_SCOPE),
    ).toBe(await generateCacheFingerprint(requestDeclsBa, 1, GEMINI_SCOPE));
  });

  it('test_generate_cache_fingerprint_trailing_content_ignored', async () => {
    const llmRequest = createLlmRequest(undefined, 3);
    const prefixCount = 2;

    const fingerprintBefore = await generateCacheFingerprint(
      llmRequest,
      prefixCount,
      GEMINI_SCOPE,
    );
    llmRequest.contents.push(userContent('A new turn'));

    expect(
      await generateCacheFingerprint(llmRequest, prefixCount, GEMINI_SCOPE),
    ).toBe(fingerprintBefore);
  });

  it('test_generate_cache_fingerprint_system_instruction_change', async () => {
    const llmRequest = createLlmRequest();

    const fingerprintOriginal = await generateCacheFingerprint(
      llmRequest,
      2,
      GEMINI_SCOPE,
    );
    llmRequest.config!.systemInstruction = 'A different instruction';

    expect(
      await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE),
    ).not.toBe(fingerprintOriginal);
  });

  it('test_populate_cache_metadata_in_response_no_invocations_increment', () => {
    const llmResponse: LlmResponse = {
      usageMetadata: {cachedContentTokenCount: 800, promptTokenCount: 1000},
    };
    const cacheMetadata = createCacheMetadata(3);

    manager.populateCacheMetadataInResponse(llmResponse, cacheMetadata);

    expect(llmResponse.cacheMetadata?.invocationsUsed).toBe(3);
    expect(llmResponse.cacheMetadata?.cacheName).toBe(cacheMetadata.cacheName);
    expect(llmResponse.cacheMetadata?.fingerprint).toBe(
      cacheMetadata.fingerprint,
    );
    expect(llmResponse.cacheMetadata?.expireTime).toBe(
      cacheMetadata.expireTime,
    );
    expect(llmResponse.cacheMetadata?.createdAt).toBe(cacheMetadata.createdAt);
    expect(llmResponse.cacheMetadata).not.toBe(cacheMetadata);
  });

  it('test_populate_cache_metadata_no_usage_metadata', () => {
    const llmResponse: LlmResponse = {};
    const cacheMetadata = createCacheMetadata(3);

    manager.populateCacheMetadataInResponse(llmResponse, cacheMetadata);

    expect(llmResponse.cacheMetadata?.invocationsUsed).toBe(3);
    expect(llmResponse.cacheMetadata?.cacheName).toBe(cacheMetadata.cacheName);
  });

  it('test_create_new_cache_with_proper_ttl', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    await manager.handleContextCaching(llmRequest);

    expect(lastCreateConfig(client).ttl).toBe('1800s');
  });

  it('test_all_but_last_content_caching', () => {
    const llmRequestMulti = createLlmRequest(undefined, 5);

    expect(Math.max(0, llmRequestMulti.contents.length - 1)).toBe(4);

    const llmRequestSingle = createLlmRequest(undefined, 1);

    expect(Math.max(0, llmRequestSingle.contents.length - 1)).toBe(0);
  });

  it('test_edge_cases', async () => {
    const llmRequestNoConfig: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('Test')],
      config: {systemInstruction: 'Test'},
      liveConnectConfig: {},
      toolsDict: {},
    };

    expect(
      await generateCacheFingerprint(llmRequestNoConfig, 2, GEMINI_SCOPE),
    ).toHaveLength(16);

    const llmRequestEmpty: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [],
      config: {systemInstruction: 'Test'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(
      await generateCacheFingerprint(llmRequestEmpty, 0, GEMINI_SCOPE),
    ).toHaveLength(16);
  });

  it('test_handle_context_caching_requires_configuration', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheConfig = undefined;

    await expect(manager.handleContextCaching(llmRequest)).rejects.toThrow(
      /cache configuration/,
    );
  });

  it('test_handle_context_caching_requires_model', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.model = undefined;

    await expect(manager.handleContextCaching(llmRequest)).rejects.toThrow(
      /model name/,
    );
  });

  it('test_parameter_types_enforcement', () => {
    const llmResponse: LlmResponse = {
      usageMetadata: {cachedContentTokenCount: 500, promptTokenCount: 1000},
    };
    const cacheMetadata = createCacheMetadata(3);

    manager.populateCacheMetadataInResponse(llmResponse, cacheMetadata);

    expect(llmResponse.cacheMetadata?.invocationsUsed).toBe(3);
  });

  it('test_cache_creation_with_sufficient_token_count', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheableContentsTokenCount = 2048;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.fingerprint).toBe(
      await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    );
    expect(result.contentsCount).toBe(0);
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('test_cache_creation_with_insufficient_token_count', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheConfig = {
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 2048,
    };
    llmRequest.cacheableContentsTokenCount = 1024;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.fingerprint).toBe(
      await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    );
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('test_cache_creation_without_token_count', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheableContentsTokenCount = undefined;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.fingerprint).toBe(
      await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
    );
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('test_fingerprint_stability_across_growing_contents_within_invocation', async () => {
    const userMsg = userContent('What is the weather?');
    const modelToolCall: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'get_weather', args: {city: 'NYC'}}}],
    };
    const toolResponse: Content = {
      role: 'user',
      parts: [
        {functionResponse: {name: 'get_weather', response: {temp: '72F'}}},
      ],
    };

    const buildRequest = (contents: Content[]): LlmRequest => ({
      model: 'gemini-2.5-flash',
      contents,
      config: {systemInstruction: 'You are a weather bot'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    });

    const fpShort = await generateCacheFingerprint(
      buildRequest([userMsg]),
      1,
      GEMINI_SCOPE,
    );
    const fpLong = await generateCacheFingerprint(
      buildRequest([userMsg, modelToolCall, toolResponse]),
      1,
      GEMINI_SCOPE,
    );

    expect(fpShort).toBe(fpLong);
  });

  it('test_fingerprint_preserved_on_cache_creation_failure', async () => {
    const llmRequest = createLlmRequest(undefined, 5);
    const fingerprintForThree = await generateCacheFingerprint(
      llmRequest,
      3,
      GEMINI_SCOPE,
    );
    llmRequest.cacheMetadata = {
      fingerprint: fingerprintForThree,
      contentsCount: 3,
    };
    llmRequest.cacheableContentsTokenCount = undefined;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.contentsCount).toBe(3);
    expect(result.fingerprint).toBe(fingerprintForThree);
  });

  it('test_multi_turn_fingerprint_stable_when_below_token_threshold', async () => {
    const fingerprintsSeen: string[] = [];
    const contentsCountsSeen: number[] = [];
    let metadata: CacheMetadata | undefined;

    for (let turn = 0; turn < 3; turn++) {
      const llmRequest = createLlmRequest(metadata, 1 + turn * 2);
      llmRequest.cacheableContentsTokenCount = undefined;

      const result = await manager.handleContextCaching(llmRequest);

      expect(result.cacheName).toBeUndefined();
      fingerprintsSeen.push(result.fingerprint);
      contentsCountsSeen.push(result.contentsCount);
      metadata = result;
    }

    // Every content in this fixture is a user content, so no prefix precedes
    // the final user batch.
    expect(new Set(fingerprintsSeen).size).toBe(1);
    expect(contentsCountsSeen).toEqual([0, 0, 0]);
  });

  it('test_contents_count_should_remain_stable_after_cache_creation_failure', async () => {
    const llmRequest = createLlmRequest(undefined, 5);
    llmRequest.cacheableContentsTokenCount = undefined;
    const originalFingerprint = await generateCacheFingerprint(
      llmRequest,
      2,
      GEMINI_SCOPE,
    );
    llmRequest.cacheMetadata = {
      fingerprint: originalFingerprint,
      contentsCount: 2,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.contentsCount).toBe(2);
    expect(result.fingerprint).toBe(originalFingerprint);
  });

  it('test_multi_tool_call_single_invocation_contents_growth', () => {
    const userMsg = userContent('Find weather and news');
    const modelToolCall1: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'get_weather', args: {city: 'NYC'}}}],
    };
    const toolResponse1: Content = {
      role: 'user',
      parts: [
        {functionResponse: {name: 'get_weather', response: {temp: '72F'}}},
      ],
    };
    const modelToolCall2: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'get_news', args: {topic: 'tech'}}}],
    };
    const toolResponse2: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'get_news',
            response: {headline: 'AI advances'},
          },
        },
      ],
    };
    const finalModelResponse = modelContent('Weather is 72F, news: AI');

    expect(findCountOfContentsToCache([userMsg])).toBe(0);
    expect(
      findCountOfContentsToCache([userMsg, modelToolCall1, toolResponse1]),
    ).toBe(2);
    expect(
      findCountOfContentsToCache([
        userMsg,
        modelToolCall1,
        toolResponse1,
        modelToolCall2,
        toolResponse2,
      ]),
    ).toBe(4);
    expect(
      findCountOfContentsToCache([
        userMsg,
        modelToolCall1,
        toolResponse1,
        modelToolCall2,
        toolResponse2,
        finalModelResponse,
      ]),
    ).toBe(6);
  });

  it('test_fingerprint_only_metadata_transitions_to_active_cache', async () => {
    const llmRequest1 = createLlmRequest(undefined, 3);

    const result1 = await manager.handleContextCaching(llmRequest1);

    expect(result1.cacheName).toBeUndefined();
    expect(result1.contentsCount).toBe(0);

    const llmRequest2 = createLlmRequest(result1, 5);
    // contentsCount is 0, so the cached prefix is the system instruction plus
    // the tools. A large previous-prompt count clears Gemini's 4096 floor.
    llmRequest2.cacheableContentsTokenCount = 30000;

    expect(
      await generateCacheFingerprint(
        llmRequest2,
        result1.contentsCount,
        GEMINI_SCOPE,
      ),
    ).toBe(result1.fingerprint);

    client.caches.create.mockResolvedValue({
      name: 'projects/test/locations/us-central1/cachedContents/new789',
    });

    const result2 = await manager.handleContextCaching(llmRequest2);

    expect(result2.cacheName).toBe(
      'projects/test/locations/us-central1/cachedContents/new789',
    );
    expect(result2.contentsCount).toBe(0);
    expect(result2.invocationsUsed).toBe(1);
    expect(client.caches.create).toHaveBeenCalledTimes(1);
    expect(lastCreateConfig(client).contents).toBeUndefined();
  });

  it('test_dynamic_instruction_does_not_break_initial_cache_fingerprint', async () => {
    const dynamicInstruction = userContent('Turn context: locale=en-US');
    const userMsg = userContent('what time is it?');
    const modelToolCall: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'get_time', args: {}}}],
    };
    const toolResponse: Content = {
      role: 'user',
      parts: [
        {functionResponse: {name: 'get_time', response: {time: '12:00'}}},
      ],
    };

    const request1 = createLlmRequest(undefined, 0);
    request1.contents = [dynamicInstruction, userMsg];

    const result1 = await manager.handleContextCaching(request1);

    expect(result1.cacheName).toBeUndefined();
    expect(result1.contentsCount).toBe(0);

    const request2 = createLlmRequest(result1, 0);
    request2.contents = [
      userMsg,
      modelToolCall,
      dynamicInstruction,
      toolResponse,
    ];
    request2.cacheableContentsTokenCount = 30000;
    client.caches.create.mockResolvedValue({
      name: 'projects/test/locations/us-central1/cachedContents/new789',
    });

    const result2 = await manager.handleContextCaching(request2);

    expect(result2.cacheName).toBe(
      'projects/test/locations/us-central1/cachedContents/new789',
    );
    expect(result2.contentsCount).toBe(2);
    expect(result2.invocationsUsed).toBe(1);
    expect(lastCreateConfig(client).contents).toEqual([userMsg, modelToolCall]);
  });

  it('test_create_cache_uses_server_expire_time', async () => {
    const serverExpireTime = new Date(2_000_000_000 * 1000).toISOString();
    client.caches.create.mockResolvedValue({
      name: 'projects/test/locations/us-central1/cachedContents/test123',
      expireTime: serverExpireTime,
    });
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.expireTime).toBe(2_000_000_000);
  });

  it('test_create_http_options_passthrough', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheConfig = {
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 0,
      createHttpOptions: {timeout: 10000},
    };
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    await manager.handleContextCaching(llmRequest);

    expect(lastCreateConfig(client).httpOptions?.timeout).toBe(10000);
  });

  it('test_create_without_http_options', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    await manager.handleContextCaching(llmRequest);

    expect(lastCreateConfig(client).httpOptions).toBeUndefined();
  });
});

describe('GeminiContextCacheManager paths the reference does not reach', () => {
  let client: FakeClient;
  let manager: GeminiContextCacheManager;

  beforeEach(() => {
    client = createClient();
    manager = new GeminiContextCacheManager(client);
  });

  it('applies a cache to a request that carries no config', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('one'), userContent('two')],
      liveConnectConfig: {},
      toolsDict: {},
    };

    applyCacheToRequest(llmRequest, 'cachedContents/abc', 1);

    expect(llmRequest.config?.cachedContent).toBe('cachedContents/abc');
    expect(llmRequest.contents).toEqual([userContent('two')]);
  });

  it('clears the cached fields when a cache applies', () => {
    const llmRequest = createLlmRequest(undefined, 2);

    applyCacheToRequest(llmRequest, 'cachedContents/abc', 1);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.config?.tools).toBeUndefined();
    expect(llmRequest.config?.toolConfig).toBeUndefined();
  });

  it('returns the measured count when the request holds no text', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [{role: 'user', parts: [{inlineData: {data: 'AAAA'}}]}],
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
      cacheableContentsTokenCount: 5000,
    };

    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(5000);
  });

  it('returns zero when no previous prompt was measured', () => {
    const llmRequest = createLlmRequest(undefined, 2);

    expect(estimateCacheablePrefixTokens(llmRequest, 1)).toBe(0);
  });

  it('counts a system instruction given as parts', () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config = {systemInstruction: ['abcd', {text: 'ef'}]};

    // 'abcd' is 4 characters and {"text":"ef"} is 13, so 17 / 4 truncates to 4.
    expect(estimateRequestTokens(llmRequest)).toBe(4);
  });

  it('counts a system instruction given as a content', () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config = {
      systemInstruction: {role: 'user', parts: [{text: 'x'}]},
    };

    expect(estimateRequestTokens(llmRequest)).toBe(
      Math.floor(
        JSON.stringify(llmRequest.config.systemInstruction).length / 4,
      ),
    );
  });

  it('degrades to fingerprint-only metadata when the cache service fails', async () => {
    client.caches.create.mockRejectedValue(new Error('boom'));
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    const fingerprint = await generateCacheFingerprint(
      llmRequest,
      0,
      GEMINI_SCOPE,
    );
    llmRequest.cacheMetadata = {fingerprint, contentsCount: 0};

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.fingerprint).toBe(fingerprint);
    expect(llmRequest.config?.cachedContent).toBeUndefined();
  });

  it('degrades to fingerprint-only metadata when the service returns no name', async () => {
    client.caches.create.mockResolvedValue({});
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
  });

  it('falls back to the requested ttl when the server reports no expiry', async () => {
    client.caches.create.mockResolvedValue({
      name: 'cachedContents/no-expiry',
    });
    const before = Date.now() / 1000;
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.expireTime).toBeGreaterThanOrEqual(before + 1800);
  });

  it('falls back to the requested ttl when the server expiry does not parse', async () => {
    client.caches.create.mockResolvedValue({
      name: 'cachedContents/bad-expiry',
      expireTime: 'not a timestamp',
    });
    const before = Date.now() / 1000;
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.expireTime).toBeGreaterThanOrEqual(before + 1800);
  });

  it('does not throw when deleting a cache fails', async () => {
    client.caches.delete.mockRejectedValue(new Error('gone'));

    await expect(
      manager.cleanupCache('cachedContents/missing'),
    ).resolves.toBeUndefined();
  });

  it('caches nothing for an empty content list', () => {
    expect(findCountOfContentsToCache([])).toBe(0);
  });

  it('keeps a cache that has served exactly its interval budget', async () => {
    const llmRequest = createLlmRequest(undefined, 3);
    llmRequest.cacheMetadata = await withRealFingerprint(
      createCacheMetadata(CACHE_CONFIG.cacheIntervals),
      llmRequest,
    );

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeDefined();
  });

  it('drops a cache one invocation past its interval budget', async () => {
    const llmRequest = createLlmRequest(undefined, 3);
    llmRequest.cacheMetadata = await withRealFingerprint(
      createCacheMetadata(CACHE_CONFIG.cacheIntervals + 1),
      llmRequest,
    );

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('keeps a cache that expires in the future', async () => {
    const llmRequest = createLlmRequest(undefined, 3);
    llmRequest.cacheMetadata = await withRealFingerprint(
      {...createCacheMetadata(1), expireTime: Date.now() / 1000 + 1},
      llmRequest,
    );

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeDefined();
  });

  it('reports no valid cache when the request carries no metadata', async () => {
    const llmRequest = createLlmRequest(undefined, 2);

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('treats a measured zero as a measurement, not as a missing count', async () => {
    // A model with no known floor, so only the measured count decides.
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.model = 'projects/test/locations/us-central1/endpoints/tuned';
    llmRequest.cacheableContentsTokenCount = 0;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };
    client.caches.create.mockResolvedValue({name: 'cachedContents/measured'});

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBe('cachedContents/measured');
  });

  it('skips cache creation below the configured minimum token count', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.cacheConfig = {
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 4_000,
    };
    llmRequest.cacheableContentsTokenCount = 3_000;
    const fingerprint = await generateCacheFingerprint(
      llmRequest,
      0,
      GEMINI_SCOPE,
    );
    llmRequest.cacheMetadata = {fingerprint, contentsCount: 0};

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.fingerprint).toBe(fingerprint);
    expect(client.caches.create).not.toHaveBeenCalled();
  });

  it('fingerprints a tool that declares no functions', async () => {
    const withSearch = createLlmRequest(undefined, 0);
    withSearch.config!.tools = [{googleSearch: {}}];
    const withoutSearch = createLlmRequest(undefined, 0);
    withoutSearch.config!.tools = [{urlContext: {}}];

    expect(
      await generateCacheFingerprint(withSearch, 0, GEMINI_SCOPE),
    ).not.toBe(await generateCacheFingerprint(withoutSearch, 0, GEMINI_SCOPE));
  });

  it('sorts a declaration that carries no name before a named one', async () => {
    const nameFirst = createLlmRequest(undefined, 0);
    nameFirst.config!.tools = [
      {functionDeclarations: [{description: 'a'}, {name: 'b'}]},
    ];
    const nameLast = createLlmRequest(undefined, 0);
    nameLast.config!.tools = [
      {functionDeclarations: [{name: 'b'}, {description: 'a'}]},
    ];

    expect(await generateCacheFingerprint(nameFirst, 0, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(nameLast, 0, GEMINI_SCOPE),
    );
  });

  it('orders two identically named declarations without reordering them', async () => {
    const twice = createLlmRequest(undefined, 0);
    twice.config!.tools = [
      {functionDeclarations: [{name: 'same'}, {name: 'same'}]},
    ];
    const once = createLlmRequest(undefined, 0);
    once.config!.tools = [{functionDeclarations: [{name: 'same'}]}];

    expect(await generateCacheFingerprint(twice, 0, GEMINI_SCOPE)).not.toBe(
      await generateCacheFingerprint(once, 0, GEMINI_SCOPE),
    );
  });

  it('counts a content that carries no parts as no characters', () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config = {};
    llmRequest.contents = [{role: 'user'}];

    expect(estimateRequestTokens(llmRequest)).toBe(0);
  });

  it('reports no token floor for a model that is not named', () => {
    expect(minimumCacheTokens(undefined)).toBeUndefined();
    expect(minimumCacheTokens('claude-3-opus')).toBeUndefined();
    expect(minimumCacheTokens('gemini-2.5-flash')).toBe(2048);
    expect(minimumCacheTokens('gemini-3-pro')).toBe(4096);
    expect(minimumCacheTokens('publishers/google/models/gemini-2.5-pro')).toBe(
      2048,
    );
  });

  it('excludes a callable tool from the fingerprint and the cache', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.systemInstruction = 'x'.repeat(12_000);
    llmRequest.config!.tools = [
      ...structuredClone(TEST_TOOLS),
      {
        tool: async () => ({}),
        callTool: async () => [],
      },
    ];
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };
    client.caches.create.mockResolvedValue({name: 'cachedContents/declared'});

    await manager.handleContextCaching(llmRequest);

    expect(lastCreateConfig(client).tools).toEqual(TEST_TOOLS);
  });

  it('omits the tools from the cache when the request declares none', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config = {systemInstruction: 'x'.repeat(12_000)};
    llmRequest.cacheableContentsTokenCount = 3_000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };
    client.caches.create.mockResolvedValue({name: 'cachedContents/no-tools'});

    await manager.handleContextCaching(llmRequest);

    expect(lastCreateConfig(client).tools).toBeUndefined();
    expect(lastCreateConfig(client).toolConfig).toBeUndefined();
  });

  it('separates the vertex and the gemini cache scopes by project', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    const scopeA: QualifiedCacheScope = {...VERTEX_SCOPE, project: 'alpha'};
    const scopeB: QualifiedCacheScope = {...VERTEX_SCOPE, project: 'beta'};

    expect(await generateCacheFingerprint(llmRequest, 0, scopeA)).not.toBe(
      await generateCacheFingerprint(llmRequest, 0, scopeB),
    );
  });

  it('keeps the caller tool order untouched while fingerprinting', async () => {
    const llmRequest = createLlmRequest(undefined, 0);
    llmRequest.config!.tools = [
      {functionDeclarations: [{name: 'zeta'}, {name: 'alpha'}]},
    ];
    const before = structuredClone(llmRequest.config!.tools);

    await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE);

    expect(llmRequest.config!.tools).toEqual(before);
  });

  it('names the vertex project and location only on a vertex client', async () => {
    const scope = {
      project: 'p',
      location: 'l',
      baseUrl: 'https://example.test',
    };
    const geminiRequest = createLlmRequest(undefined, 0);
    const vertexRequest = createLlmRequest(undefined, 0);
    const geminiManager = new GeminiContextCacheManager(
      createClient(false),
      scope,
    );
    const vertexManager = new GeminiContextCacheManager(
      createClient(true),
      scope,
    );

    const geminiMetadata =
      await geminiManager.handleContextCaching(geminiRequest);
    const vertexMetadata =
      await vertexManager.handleContextCaching(vertexRequest);

    expect(geminiMetadata.fingerprint).toBe(
      await generateCacheFingerprint(geminiRequest, 0, {
        backend: 'gemini',
        baseUrl: scope.baseUrl,
      }),
    );
    expect(vertexMetadata.fingerprint).toBe(
      await generateCacheFingerprint(vertexRequest, 0, {
        backend: 'vertex',
        ...scope,
      }),
    );
  });
});
