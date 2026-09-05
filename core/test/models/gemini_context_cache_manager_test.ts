/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `tests/unittests/agents/test_gemini_context_cache_manager.py`
 * at google/adk-python commit 4ff1d5d (the file is 1505 lines and holds 48
 * tests). Each `it` keeps the Python test name verbatim.
 *
 * Python patches the private `_generate_cache_fingerprint` in several tests to
 * pin a value. TypeScript forbids widening a private member for a test, so
 * these ports build requests whose real fingerprints match or differ, which
 * also keeps the digest itself under test.
 */

import {
  CachedContent,
  Content,
  CreateCachedContentParameters,
  DeleteCachedContentParameters,
  DeleteCachedContentResponse,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  GenerateContentConfig,
  Tool,
  Type,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ContextCacheConfig} from '../../src/agents/context_cache_config.js';
import {
  ActiveCacheMetadata,
  CacheMetadata,
} from '../../src/models/cache_metadata.js';
import {
  GeminiContextCacheManager,
  QualifiedCacheScope,
  findCountOfContentsToCache,
  generateCacheFingerprint,
  validActiveCache,
} from '../../src/models/gemini_context_cache_manager.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  // Zero lets these tests exercise the model floor rather than this gate.
  minTokens: 0,
};

const GEMINI_SCOPE: QualifiedCacheScope = {backend: 'gemini'};

const EXISTING_CACHE_NAME =
  'projects/test/locations/us-central1/cachedContents/test123';

const MILLISECONDS_PER_SECOND = 1000;

/** An `LlmRequest` whose `config` is always present, so a test can edit it. */
interface TestLlmRequest extends LlmRequest {
  config: GenerateContentConfig;
}

interface FakeClient {
  client: GeminiContextCacheManagerClient;
  create: ReturnType<typeof createCacheMock>;
  remove: ReturnType<typeof removeCacheMock>;
}

/** The structural client slice the manager takes. */
type GeminiContextCacheManagerClient = ConstructorParameters<
  typeof GeminiContextCacheManager
>[0];

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

function testTool(): Tool {
  return {
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
}

function userContent(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

function modelContent(text: string): Content {
  return {role: 'model', parts: [{text}]};
}

function createLlmRequest(
  options: {cacheMetadata?: CacheMetadata; contentsCount?: number} = {},
): TestLlmRequest {
  const contentsCount = options.contentsCount ?? 3;
  const contents: Content[] = [];
  for (let index = 0; index < contentsCount; index++) {
    contents.push(userContent(`Test message ${index}`));
  }
  return {
    model: 'gemini-2.5-flash',
    contents,
    config: {
      systemInstruction: 'Test instruction',
      tools: [testTool()],
      toolConfig: {
        functionCallingConfig: {mode: FunctionCallingConfigMode.AUTO},
      },
    },
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: CACHE_CONFIG,
    cacheMetadata: options.cacheMetadata,
  };
}

function nowInSeconds(): number {
  return Date.now() / MILLISECONDS_PER_SECOND;
}

function createCacheMetadata(
  options: {
    invocationsUsed?: number;
    expired?: boolean;
    contentsCount?: number;
    fingerprint?: string;
  } = {},
): ActiveCacheMetadata {
  const now = nowInSeconds();
  return {
    cacheName: EXISTING_CACHE_NAME,
    expireTime: options.expired ? now - 300 : now + 1800,
    fingerprint: options.fingerprint ?? 'test_fingerprint',
    invocationsUsed: options.invocationsUsed ?? 0,
    contentsCount: options.contentsCount ?? 3,
    createdAt: now - 600,
  };
}

describe('GeminiContextCacheManager', () => {
  let fake: FakeClient;
  let manager: GeminiContextCacheManager;

  beforeEach(() => {
    fake = createFakeClient();
    manager = new GeminiContextCacheManager(fake.client);
  });

  // Python asserts `manager.genai_client == mock_client`. The client stays
  // private here, so this asserts the observable equivalent: the manager
  // operates on the client it was built with.
  it('test_init', async () => {
    const other = createFakeClient();

    await manager.cleanupCache('cachedContents/owned');

    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledWith({name: 'cachedContents/owned'});
    expect(other.remove).not.toHaveBeenCalled();
  });

  it('test_handle_context_caching_no_existing_cache', async () => {
    const llmRequest = createLlmRequest({contentsCount: 5});
    const expected = await generateCacheFingerprint(
      llmRequest,
      0,
      GEMINI_SCOPE,
    );

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.expireTime).toBeUndefined();
    expect(result.invocationsUsed).toBeUndefined();
    expect(result.createdAt).toBeUndefined();
    expect(result.fingerprint).toBe(expected);
    expect(result.contentsCount).toBe(0);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('test_handle_context_caching_valid_existing_cache', async () => {
    const llmRequest = createLlmRequest();
    const existingCache = createCacheMetadata({
      invocationsUsed: 5,
      contentsCount: 3,
      fingerprint: await generateCacheFingerprint(llmRequest, 3, GEMINI_SCOPE),
    });
    llmRequest.cacheMetadata = existingCache;

    const result = await manager.handleContextCaching(llmRequest);

    expect(result).toEqual(existingCache);
    expect(result).not.toBe(existingCache);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('test_handle_context_caching_invalid_cache_fingerprint_match', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheableContentsTokenCount = 5000;
    llmRequest.cacheMetadata = createCacheMetadata({
      invocationsUsed: 15, // Exceeds cacheIntervals.
      contentsCount: 3,
      fingerprint: await generateCacheFingerprint(llmRequest, 3, GEMINI_SCOPE),
    });
    fake.create.mockResolvedValue({
      name: 'projects/test/locations/us-central1/cachedContents/new456',
    });

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBe(
      'projects/test/locations/us-central1/cachedContents/new456',
    );
    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledWith({name: EXISTING_CACHE_NAME});
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it('test_model_change_invalidates_active_cache', async () => {
    const flashRequest = createLlmRequest({contentsCount: 0});
    const flashMetadata = await manager.handleContextCaching(flashRequest);
    const activeMetadata: ActiveCacheMetadata = {
      cacheName: 'cachedContents/flash-cache',
      expireTime: nowInSeconds() + 1800,
      fingerprint: flashMetadata.fingerprint,
      invocationsUsed: 1,
      contentsCount: flashMetadata.contentsCount,
      createdAt: nowInSeconds(),
    };
    const proRequest = createLlmRequest({
      cacheMetadata: activeMetadata,
      contentsCount: 0,
    });
    proRequest.model = 'gemini-2.5-pro';

    const proMetadata = await manager.handleContextCaching(proRequest);

    expect(proMetadata.cacheName).toBeUndefined();
    expect(proMetadata.fingerprint).not.toBe(activeMetadata.fingerprint);
    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledWith({
      name: 'cachedContents/flash-cache',
    });
  });

  it('test_backend_change_invalidates_active_cache', async () => {
    const developerRequest = createLlmRequest({contentsCount: 0});
    const developerMetadata =
      await manager.handleContextCaching(developerRequest);
    const activeMetadata: ActiveCacheMetadata = {
      cacheName: 'cachedContents/developer-cache',
      expireTime: nowInSeconds() + 1800,
      fingerprint: developerMetadata.fingerprint,
      invocationsUsed: 1,
      contentsCount: developerMetadata.contentsCount,
      createdAt: nowInSeconds(),
    };
    const vertex = createFakeClient(true);
    const vertexManager = new GeminiContextCacheManager(vertex.client);
    const vertexRequest = createLlmRequest({
      cacheMetadata: activeMetadata,
      contentsCount: 0,
    });

    const vertexMetadata =
      await vertexManager.handleContextCaching(vertexRequest);

    expect(vertexMetadata.cacheName).toBeUndefined();
    expect(vertexMetadata.fingerprint).not.toBe(activeMetadata.fingerprint);
    expect(vertex.remove).toHaveBeenCalledTimes(1);
    expect(vertex.remove).toHaveBeenCalledWith({
      name: 'cachedContents/developer-cache',
    });
  });

  it('test_create_cache_gates_on_prefix_not_full_prompt', async () => {
    // A tiny cacheable prefix followed by a huge trailing user turn. The full
    // previous prompt clears Gemini's floor; the prefix does not.
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [
        userContent('Short prefix.'),
        userContent('word '.repeat(100000)),
      ],
      config: {systemInstruction: 'You are a helpful assistant.'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
      cacheableContentsTokenCount: 75000,
    };
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 1, GEMINI_SCOPE),
      contentsCount: 1,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.contentsCount).toBe(1);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('test_completed_turn_grows_cacheable_prefix', async () => {
    const firstUser = userContent('First question');
    const firstModel = modelContent('First answer');
    const nextUser = userContent('Next question');
    const firstRequest = createLlmRequest({contentsCount: 0});
    firstRequest.contents = [firstUser];

    const firstMetadata = await manager.handleContextCaching(firstRequest);

    expect(firstMetadata.contentsCount).toBe(0);

    const nextRequest = createLlmRequest({
      cacheMetadata: firstMetadata,
      contentsCount: 0,
    });
    nextRequest.contents = [firstUser, firstModel, nextUser];
    nextRequest.cacheableContentsTokenCount = 30000;
    fake.create.mockResolvedValue({name: 'cachedContents/grown-prefix'});

    const nextMetadata = await manager.handleContextCaching(nextRequest);

    expect(nextMetadata.cacheName).toBe('cachedContents/grown-prefix');
    expect(nextMetadata.contentsCount).toBe(2);
    expect(fake.create.mock.calls[0][0].config?.contents).toEqual([
      firstUser,
      firstModel,
    ]);
    expect(nextRequest.contents).toEqual([nextUser]);
  });

  it('test_cache_reuse_keeps_final_content_in_request', async () => {
    const onlyUser = userContent('Plan the next step');
    const llmRequest = createLlmRequest({contentsCount: 0});
    llmRequest.contents = [onlyUser];
    llmRequest.cacheMetadata = createCacheMetadata({
      invocationsUsed: 1,
      contentsCount: 1,
      fingerprint: await generateCacheFingerprint(llmRequest, 1, GEMINI_SCOPE),
    });

    await manager.handleContextCaching(llmRequest);

    expect(llmRequest.contents).toEqual([onlyUser]);
    expect(llmRequest.config.cachedContent).toBe(EXISTING_CACHE_NAME);
  });

  it('test_cache_creation_keeps_final_content_in_request', async () => {
    const userMessage = userContent('First question');
    const modelMessage = modelContent('First answer');
    const firstRequest = createLlmRequest({contentsCount: 0});
    firstRequest.contents = [userMessage];

    const firstMetadata = await manager.handleContextCaching(firstRequest);

    const nextRequest = createLlmRequest({
      cacheMetadata: firstMetadata,
      contentsCount: 0,
    });
    nextRequest.contents = [userMessage, modelMessage];
    nextRequest.cacheableContentsTokenCount = 30000;
    fake.create.mockResolvedValue({name: 'cachedContents/full-prefix'});

    const nextMetadata = await manager.handleContextCaching(nextRequest);

    expect(nextMetadata.contentsCount).toBe(2);
    expect(nextRequest.contents).toEqual([modelMessage]);
  });

  it('test_gemini_25_creates_cache_above_2048_token_minimum', async () => {
    const llmRequest = createLlmRequest({contentsCount: 0});
    llmRequest.config.systemInstruction = 'x'.repeat(12000);
    llmRequest.cacheableContentsTokenCount = 3000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };
    fake.create.mockResolvedValue({name: 'cachedContents/gemini-25'});

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBe('cachedContents/gemini-25');
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it('test_gemini_3_skips_cache_below_4096_token_minimum', async () => {
    const llmRequest = createLlmRequest({contentsCount: 0});
    llmRequest.model = 'gemini-3.1-pro-preview';
    llmRequest.config.systemInstruction = 'x'.repeat(12000);
    llmRequest.cacheableContentsTokenCount = 3000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('test_opaque_model_does_not_apply_guessed_token_minimum', async () => {
    const llmRequest = createLlmRequest({contentsCount: 0});
    llmRequest.model =
      'projects/test/locations/us-central1/endpoints/tuned-model';
    llmRequest.config.systemInstruction = 'x'.repeat(12000);
    llmRequest.cacheableContentsTokenCount = 3000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 0, GEMINI_SCOPE),
      contentsCount: 0,
    };
    fake.create.mockResolvedValue({name: 'cachedContents/tuned-model'});

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBe('cachedContents/tuned-model');
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it('test_handle_context_caching_invalid_cache_fingerprint_mismatch', async () => {
    const llmRequest = createLlmRequest({contentsCount: 5});
    llmRequest.cacheMetadata = createCacheMetadata({
      invocationsUsed: 15,
      contentsCount: 3,
      fingerprint: 'a_fingerprint_of_a_prefix_that_moved',
    });
    const expected = await generateCacheFingerprint(
      llmRequest,
      0,
      GEMINI_SCOPE,
    );

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.expireTime).toBeUndefined();
    expect(result.invocationsUsed).toBeUndefined();
    expect(result.createdAt).toBeUndefined();
    expect(result.fingerprint).toBe(expected);
    expect(result.contentsCount).toBe(0);
    expect(fake.remove).toHaveBeenCalledWith({name: EXISTING_CACHE_NAME});
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('test_is_cache_valid_fingerprint_mismatch', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheMetadata = createCacheMetadata({
      fingerprint: 'different_fingerprint',
    });

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('test_is_cache_valid_expired_cache', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheMetadata = createCacheMetadata({
      expired: true,
      fingerprint: await generateCacheFingerprint(llmRequest, 3, GEMINI_SCOPE),
    });

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('test_is_cache_valid_fingerprint_only_metadata', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheMetadata = {
      fingerprint: 'test_fingerprint',
      contentsCount: 5,
    };

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('test_is_cache_valid_cache_intervals_exceeded', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheMetadata = createCacheMetadata({
      invocationsUsed: 15,
      fingerprint: await generateCacheFingerprint(llmRequest, 3, GEMINI_SCOPE),
    });

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toBeUndefined();
  });

  it('test_is_cache_valid_all_checks_pass', async () => {
    const llmRequest = createLlmRequest();
    const cacheMetadata = createCacheMetadata({
      invocationsUsed: 5,
      fingerprint: await generateCacheFingerprint(llmRequest, 3, GEMINI_SCOPE),
    });
    llmRequest.cacheMetadata = cacheMetadata;

    expect(await validActiveCache(llmRequest, GEMINI_SCOPE)).toEqual(
      cacheMetadata,
    );
  });

  it('test_cleanup_cache', async () => {
    await manager.cleanupCache(EXISTING_CACHE_NAME);

    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledWith({name: EXISTING_CACHE_NAME});
  });

  it('test_generate_cache_fingerprint', async () => {
    const llmRequest = createLlmRequest();
    const cacheContentsCount = 2;

    const first = await generateCacheFingerprint(
      llmRequest,
      cacheContentsCount,
      GEMINI_SCOPE,
    );
    const second = await generateCacheFingerprint(
      llmRequest,
      cacheContentsCount,
      GEMINI_SCOPE,
    );

    expect(first).toBe(second);
    expect(first).toHaveLength(16);

    const withoutTools: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('Test')],
      config: {systemInstruction: 'Test instruction'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(first).not.toBe(
      await generateCacheFingerprint(
        withoutTools,
        cacheContentsCount,
        GEMINI_SCOPE,
      ),
    );
  });

  it('test_generate_cache_fingerprint_different_requests', async () => {
    const first = createLlmRequest();
    const second: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('Different message')],
      config: {systemInstruction: 'Different instruction'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(await generateCacheFingerprint(first, 2, GEMINI_SCOPE)).not.toBe(
      await generateCacheFingerprint(second, 2, GEMINI_SCOPE),
    );
  });

  it('test_generate_cache_fingerprint_canonicalizes_mapping_order', async () => {
    const first = createLlmRequest({contentsCount: 0});
    const second = createLlmRequest({contentsCount: 0});
    first.contents = [
      {
        role: 'model',
        parts: [{functionCall: {name: 'lookup', args: {first: 1, second: 2}}}],
      },
    ];
    second.contents = [
      {
        role: 'model',
        parts: [{functionCall: {name: 'lookup', args: {second: 2, first: 1}}}],
      },
    ];

    expect(await generateCacheFingerprint(first, 1, GEMINI_SCOPE)).toBe(
      await generateCacheFingerprint(second, 1, GEMINI_SCOPE),
    );
  });

  it('test_generate_cache_fingerprint_tool_config_variations', async () => {
    const auto = createLlmRequest();
    const none: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('Test')],
      config: {
        systemInstruction: 'Test instruction',
        tools: auto.config.tools,
        toolConfig: {
          functionCallingConfig: {mode: FunctionCallingConfigMode.NONE},
        },
      },
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(await generateCacheFingerprint(auto, 2, GEMINI_SCOPE)).not.toBe(
      await generateCacheFingerprint(none, 2, GEMINI_SCOPE),
    );
  });

  it('test_generate_cache_fingerprint_tool_order_independent', async () => {
    const alpha: FunctionDeclaration = {name: 'alpha', description: 'a'};
    const beta: FunctionDeclaration = {name: 'beta', description: 'b'};
    const content = userContent('Test');
    const requestWithTools = (tools: Tool[]): LlmRequest => ({
      model: 'gemini-2.5-flash',
      contents: [content],
      config: {systemInstruction: 'Test instruction', tools},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    });

    // Two tools, one declaration each, in opposite order.
    const toolsAb = [
      {functionDeclarations: [alpha]},
      {functionDeclarations: [beta]},
    ];
    const toolsBa = [
      {functionDeclarations: [beta]},
      {functionDeclarations: [alpha]},
    ];
    expect(
      await generateCacheFingerprint(
        requestWithTools(toolsAb),
        1,
        GEMINI_SCOPE,
      ),
    ).toBe(
      await generateCacheFingerprint(
        requestWithTools(toolsBa),
        1,
        GEMINI_SCOPE,
      ),
    );

    // One tool with two declarations, in opposite order.
    const declarationsAb = [{functionDeclarations: [alpha, beta]}];
    const declarationsBa = [{functionDeclarations: [beta, alpha]}];
    expect(
      await generateCacheFingerprint(
        requestWithTools(declarationsAb),
        1,
        GEMINI_SCOPE,
      ),
    ).toBe(
      await generateCacheFingerprint(
        requestWithTools(declarationsBa),
        1,
        GEMINI_SCOPE,
      ),
    );

    // The caller's own arrays keep their order.
    expect(declarationsAb[0].functionDeclarations).toEqual([alpha, beta]);
    expect(toolsAb[0].functionDeclarations).toEqual([alpha]);
  });

  it('test_generate_cache_fingerprint_trailing_content_ignored', async () => {
    const llmRequest = createLlmRequest({contentsCount: 3});
    const prefixCount = 2;

    const before = await generateCacheFingerprint(
      llmRequest,
      prefixCount,
      GEMINI_SCOPE,
    );
    llmRequest.contents.push(userContent('A new turn'));
    const after = await generateCacheFingerprint(
      llmRequest,
      prefixCount,
      GEMINI_SCOPE,
    );

    expect(before).toBe(after);
  });

  it('test_generate_cache_fingerprint_system_instruction_change', async () => {
    const llmRequest = createLlmRequest();

    const original = await generateCacheFingerprint(
      llmRequest,
      2,
      GEMINI_SCOPE,
    );
    llmRequest.config.systemInstruction = 'A different instruction';
    const changed = await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE);

    expect(original).not.toBe(changed);
  });

  it('test_populate_cache_metadata_in_response_no_invocations_increment', () => {
    const llmResponse: LlmResponse = {
      usageMetadata: {cachedContentTokenCount: 800, promptTokenCount: 1000},
    };
    const cacheMetadata = createCacheMetadata({invocationsUsed: 3});

    manager.populateCacheMetadataInResponse(llmResponse, cacheMetadata);

    expect(llmResponse.cacheMetadata).toEqual(cacheMetadata);
    expect(llmResponse.cacheMetadata?.invocationsUsed).toBe(3);
  });

  it('test_populate_cache_metadata_no_usage_metadata', () => {
    const llmResponse: LlmResponse = {};
    const cacheMetadata = createCacheMetadata({invocationsUsed: 3});

    manager.populateCacheMetadataInResponse(llmResponse, cacheMetadata);

    expect(llmResponse.cacheMetadata?.invocationsUsed).toBe(3);
    expect(llmResponse.cacheMetadata?.cacheName).toBe(cacheMetadata.cacheName);
  });

  it('test_create_new_cache_with_proper_ttl', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheableContentsTokenCount = 30000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE),
      contentsCount: 2,
    };

    await manager.handleContextCaching(llmRequest);

    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.create.mock.calls[0][0].config?.ttl).toBe('1800s');
  });

  it('test_all_but_last_content_caching', () => {
    // Five contents whose last one opens a new turn: the four before it cache.
    const settled = [
      userContent('a'),
      modelContent('b'),
      userContent('c'),
      modelContent('d'),
      userContent('e'),
    ];
    expect(findCountOfContentsToCache(settled)).toBe(4);

    expect(findCountOfContentsToCache([userContent('only')])).toBe(0);
  });

  it('test_edge_cases', async () => {
    const withoutCacheConfig: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [userContent('Test')],
      config: {systemInstruction: 'Test'},
      liveConnectConfig: {},
      toolsDict: {},
    };

    expect(
      await generateCacheFingerprint(withoutCacheConfig, 2, GEMINI_SCOPE),
    ).toHaveLength(16);

    const withoutContents: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [],
      config: {systemInstruction: 'Test'},
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig: CACHE_CONFIG,
    };

    expect(
      await generateCacheFingerprint(withoutContents, 0, GEMINI_SCOPE),
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

  it('test_cache_creation_with_sufficient_token_count', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheableContentsTokenCount = 2048;
    const expected = await generateCacheFingerprint(
      llmRequest,
      0,
      GEMINI_SCOPE,
    );

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.fingerprint).toBe(expected);
    expect(result.contentsCount).toBe(0);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('test_cache_creation_with_insufficient_token_count', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheConfig = {
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 2048,
    };
    llmRequest.cacheableContentsTokenCount = 1024;
    const expected = await generateCacheFingerprint(
      llmRequest,
      0,
      GEMINI_SCOPE,
    );

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.fingerprint).toBe(expected);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('test_cache_creation_without_token_count', async () => {
    const llmRequest = createLlmRequest();
    const expected = await generateCacheFingerprint(
      llmRequest,
      0,
      GEMINI_SCOPE,
    );

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.cacheName).toBeUndefined();
    expect(result.fingerprint).toBe(expected);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('test_fingerprint_stability_across_growing_contents_within_invocation', async () => {
    const userMessage = userContent('What is the weather?');
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

    const short = await generateCacheFingerprint(
      buildRequest([userMessage]),
      1,
      GEMINI_SCOPE,
    );
    const long = await generateCacheFingerprint(
      buildRequest([userMessage, modelToolCall, toolResponse]),
      1,
      GEMINI_SCOPE,
    );

    expect(short).toBe(long);
  });

  it('test_fingerprint_preserved_on_cache_creation_failure', async () => {
    const llmRequest = createLlmRequest({contentsCount: 5});
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
      const llmRequest = createLlmRequest({
        cacheMetadata: metadata,
        contentsCount: 1 + turn * 2,
      });
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
    const llmRequest = createLlmRequest({contentsCount: 5});
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
    const userMessage = userContent('Find weather and news');
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
    const finalModelResponse = modelContent(
      'Weather is 72F, news: AI advances',
    );

    expect(findCountOfContentsToCache([userMessage])).toBe(0);
    expect(
      findCountOfContentsToCache([userMessage, modelToolCall1, toolResponse1]),
    ).toBe(2);
    expect(
      findCountOfContentsToCache([
        userMessage,
        modelToolCall1,
        toolResponse1,
        modelToolCall2,
        toolResponse2,
      ]),
    ).toBe(4);
    expect(
      findCountOfContentsToCache([
        userMessage,
        modelToolCall1,
        toolResponse1,
        modelToolCall2,
        toolResponse2,
        finalModelResponse,
      ]),
    ).toBe(6);
  });

  it('test_fingerprint_only_metadata_transitions_to_active_cache', async () => {
    const firstRequest = createLlmRequest({contentsCount: 3});

    const firstResult = await manager.handleContextCaching(firstRequest);

    expect(firstResult.cacheName).toBeUndefined();
    expect(firstResult.contentsCount).toBe(0);

    const secondRequest = createLlmRequest({
      cacheMetadata: firstResult,
      contentsCount: 5,
    });
    // contentsCount is 0, so the cached prefix is the system instruction plus
    // the tools. A large previous-prompt count clears Gemini's floor.
    secondRequest.cacheableContentsTokenCount = 30000;

    expect(
      await generateCacheFingerprint(
        secondRequest,
        firstResult.contentsCount,
        GEMINI_SCOPE,
      ),
    ).toBe(firstResult.fingerprint);

    fake.create.mockResolvedValue({
      name: 'projects/test/locations/us-central1/cachedContents/new789',
    });

    const secondResult = await manager.handleContextCaching(secondRequest);

    expect(secondResult.cacheName).toBe(
      'projects/test/locations/us-central1/cachedContents/new789',
    );
    expect(secondResult.contentsCount).toBe(0);
    expect(secondResult.invocationsUsed).toBe(1);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.create.mock.calls[0][0].config?.contents).toBeUndefined();
  });

  it('test_dynamic_instruction_does_not_break_initial_cache_fingerprint', async () => {
    const dynamicInstruction = userContent('Turn context: locale=en-US');
    const userMessage = userContent('what time is it?');
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
    const firstRequest = createLlmRequest({contentsCount: 0});
    firstRequest.contents = [dynamicInstruction, userMessage];

    const firstResult = await manager.handleContextCaching(firstRequest);

    expect(firstResult.cacheName).toBeUndefined();
    expect(firstResult.contentsCount).toBe(0);

    const secondRequest = createLlmRequest({
      cacheMetadata: firstResult,
      contentsCount: 0,
    });
    secondRequest.contents = [
      userMessage,
      modelToolCall,
      dynamicInstruction,
      toolResponse,
    ];
    secondRequest.cacheableContentsTokenCount = 30000;
    fake.create.mockResolvedValue({
      name: 'projects/test/locations/us-central1/cachedContents/new789',
    });

    const secondResult = await manager.handleContextCaching(secondRequest);

    expect(secondResult.cacheName).toBe(
      'projects/test/locations/us-central1/cachedContents/new789',
    );
    expect(secondResult.contentsCount).toBe(2);
    expect(secondResult.invocationsUsed).toBe(1);
    expect(fake.create.mock.calls[0][0].config?.contents).toEqual([
      userMessage,
      modelToolCall,
    ]);
  });

  it('test_create_cache_uses_server_expire_time', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheableContentsTokenCount = 30000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE),
      contentsCount: 2,
    };
    fake.create.mockResolvedValue({
      name: EXISTING_CACHE_NAME,
      expireTime: '2033-05-18T03:33:20Z',
    });

    const result = await manager.handleContextCaching(llmRequest);

    expect(result.expireTime).toBe(2000000000);
  });

  it('test_create_http_options_passthrough', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheConfig = {
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 0,
      createHttpOptions: {timeout: 10000},
    };
    llmRequest.cacheableContentsTokenCount = 30000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE),
      contentsCount: 2,
    };

    await manager.handleContextCaching(llmRequest);

    expect(fake.create.mock.calls[0][0].config?.httpOptions?.timeout).toBe(
      10000,
    );
  });

  it('test_create_without_http_options', async () => {
    const llmRequest = createLlmRequest();
    llmRequest.cacheableContentsTokenCount = 30000;
    llmRequest.cacheMetadata = {
      fingerprint: await generateCacheFingerprint(llmRequest, 2, GEMINI_SCOPE),
      contentsCount: 2,
    };

    await manager.handleContextCaching(llmRequest);

    expect(fake.create.mock.calls[0][0].config?.httpOptions).toBeUndefined();
  });
});
