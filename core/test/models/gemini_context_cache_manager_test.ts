/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionCallingConfigMode,
  GoogleGenAI,
  Tool,
  Type,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  ContextCacheConfig,
  createContextCacheConfig,
} from '../../src/agents/context_cache_config.js';
import {
  CacheMetadata,
  createCacheMetadata,
} from '../../src/models/cache_metadata.js';
import {
  applyCacheToRequest,
  canonicalJson,
  estimateCacheablePrefixTokens,
  estimateRequestTokens,
  findCountOfContentsToCache,
  GEMINI_2_5_MIN_CACHE_TOKENS,
  GEMINI_3_MIN_CACHE_TOKENS,
  GeminiContextCacheManager,
  minimumCacheTokens,
} from '../../src/models/gemini_context_cache_manager.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';

// Typed accessor for exercising private methods faithfully to the reference
// tests, without resorting to `any`.
interface ManagerInternals {
  isCacheValid(req: LlmRequest): boolean;
  generateCacheFingerprint(req: LlmRequest, count: number): string;
  createGeminiCache(req: LlmRequest, count: number): Promise<CacheMetadata>;
  createNewCacheWithContents(
    req: LlmRequest,
    count: number,
  ): Promise<CacheMetadata | undefined>;
  cacheScope(): Record<string, unknown>;
}
const internals = (manager: GeminiContextCacheManager): ManagerInternals =>
  manager as unknown as ManagerInternals;

const nowSeconds = () => Date.now() / 1000;

interface MockCaches {
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeClient(vertexai = false): {
  client: GoogleGenAI;
  caches: MockCaches;
} {
  const caches: MockCaches = {
    create: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const client = {caches, vertexai} as unknown as GoogleGenAI;
  return {client, caches};
}

const userContent = (text: string): Content => ({
  role: 'user',
  parts: [{text}],
});
const modelContent = (text: string): Content => ({
  role: 'model',
  parts: [{text}],
});
const modelCall = (name: string, args: Record<string, unknown>): Content => ({
  role: 'model',
  parts: [{functionCall: {name, args}}],
});
const toolResponse = (
  name: string,
  response: Record<string, unknown>,
): Content => ({
  role: 'user',
  parts: [{functionResponse: {name, response}}],
});

const TEST_CACHE_CONFIG = createContextCacheConfig({
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 0,
});

function createLlmRequest(
  opts: {
    cacheMetadata?: CacheMetadata;
    contentsCount?: number;
    model?: string;
    cacheConfig?: ContextCacheConfig;
  } = {},
): LlmRequest {
  const contentsCount = opts.contentsCount ?? 3;
  const contents: Content[] = [];
  for (let i = 0; i < contentsCount; i++) {
    contents.push(userContent(`Test message ${i}`));
  }
  const tools: Tool[] = [
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
  return {
    model: opts.model ?? 'gemini-2.5-flash',
    contents,
    config: {
      systemInstruction: 'Test instruction',
      tools,
      toolConfig: {
        functionCallingConfig: {mode: FunctionCallingConfigMode.AUTO},
      },
    },
    liveConnectConfig: {},
    toolsDict: {},
    cacheConfig: opts.cacheConfig ?? TEST_CACHE_CONFIG,
    cacheMetadata: opts.cacheMetadata,
  };
}

describe('GeminiContextCacheManager', () => {
  let client: GoogleGenAI;
  let caches: MockCaches;
  let manager: GeminiContextCacheManager;

  beforeEach(() => {
    ({client, caches} = makeClient());
    manager = new GeminiContextCacheManager(client);
  });

  describe('cache-key stability (fingerprint)', () => {
    it('is deterministic for identical requests', () => {
      const request = createLlmRequest();
      const fp1 = internals(manager).generateCacheFingerprint(request, 2);
      const fp2 = internals(manager).generateCacheFingerprint(request, 2);
      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(16);
    });

    it('canonicalizes object/mapping order', () => {
      const first = createLlmRequest({contentsCount: 0});
      first.contents = [modelCall('lookup', {first: 1, second: 2})];
      const second = createLlmRequest({contentsCount: 0});
      second.contents = [modelCall('lookup', {second: 2, first: 1})];
      expect(internals(manager).generateCacheFingerprint(first, 1)).toBe(
        internals(manager).generateCacheFingerprint(second, 1),
      );
    });

    it('differs when the model changes', () => {
      const base = createLlmRequest();
      const other = createLlmRequest({model: 'gemini-2.5-pro'});
      expect(internals(manager).generateCacheFingerprint(base, 2)).not.toBe(
        internals(manager).generateCacheFingerprint(other, 2),
      );
    });

    it('differs when the system instruction changes', () => {
      const base = createLlmRequest();
      const other = createLlmRequest();
      other.config!.systemInstruction = 'Different instruction';
      expect(internals(manager).generateCacheFingerprint(base, 2)).not.toBe(
        internals(manager).generateCacheFingerprint(other, 2),
      );
    });

    it('differs when tools are present versus absent', () => {
      const withTools = createLlmRequest();
      const withoutTools = createLlmRequest();
      withoutTools.config!.tools = undefined;
      expect(
        internals(manager).generateCacheFingerprint(withTools, 2),
      ).not.toBe(internals(manager).generateCacheFingerprint(withoutTools, 2));
    });

    it('differs when the tool config changes', () => {
      const auto = createLlmRequest();
      const none = createLlmRequest();
      none.config!.toolConfig = {
        functionCallingConfig: {mode: FunctionCallingConfigMode.NONE},
      };
      expect(internals(manager).generateCacheFingerprint(auto, 2)).not.toBe(
        internals(manager).generateCacheFingerprint(none, 2),
      );
    });

    it('differs when the cached contents change', () => {
      const base = createLlmRequest({contentsCount: 3});
      const other = createLlmRequest({contentsCount: 3});
      other.contents[0] = userContent('A totally different first message');
      expect(internals(manager).generateCacheFingerprint(base, 2)).not.toBe(
        internals(manager).generateCacheFingerprint(other, 2),
      );
    });

    it('is stable across growing trailing user contents within an invocation', () => {
      const userMsg = userContent('What is the weather?');
      const short = createLlmRequest({contentsCount: 0});
      short.config!.systemInstruction = 'You are a weather bot';
      short.config!.tools = undefined;
      short.config!.toolConfig = undefined;
      short.contents = [userMsg];

      const long = createLlmRequest({contentsCount: 0});
      long.config!.systemInstruction = 'You are a weather bot';
      long.config!.tools = undefined;
      long.config!.toolConfig = undefined;
      long.contents = [
        userMsg,
        modelCall('get_weather', {city: 'NYC'}),
        toolResponse('get_weather', {temp: '72F'}),
      ];

      expect(internals(manager).generateCacheFingerprint(short, 1)).toBe(
        internals(manager).generateCacheFingerprint(long, 1),
      );
    });
  });

  describe('floor gating (below floor => no cache)', () => {
    it('creates a cache for gemini-2.5 above the 2048-token minimum', async () => {
      const request = createLlmRequest({contentsCount: 0});
      request.config!.systemInstruction = 'x'.repeat(12000);
      request.cacheableContentsTokenCount = 3000;
      request.cacheMetadata = createCacheMetadata({
        fingerprint: internals(manager).generateCacheFingerprint(request, 0),
        contentsCount: 0,
      });
      caches.create.mockResolvedValue({name: 'cachedContents/gemini-25'});

      const result = await manager.handleContextCaching(request);

      expect(result?.cacheName).toBe('cachedContents/gemini-25');
      expect(caches.create).toHaveBeenCalledOnce();
    });

    it('skips a cache for gemini-3 below the 4096-token minimum', async () => {
      const request = createLlmRequest({
        contentsCount: 0,
        model: 'gemini-3.1-pro-preview',
      });
      request.config!.systemInstruction = 'x'.repeat(12000);
      request.cacheableContentsTokenCount = 3000;
      request.cacheMetadata = createCacheMetadata({
        fingerprint: internals(manager).generateCacheFingerprint(request, 0),
        contentsCount: 0,
      });

      const result = await manager.handleContextCaching(request);

      expect(result?.cacheName).toBeUndefined();
      expect(caches.create).not.toHaveBeenCalled();
    });

    it('gates on the cacheable prefix, not the full prompt', async () => {
      const request: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [
          userContent('Short prefix.'),
          userContent('word '.repeat(100000)),
        ],
        config: {systemInstruction: 'You are a helpful assistant.'},
        liveConnectConfig: {},
        toolsDict: {},
        cacheConfig: TEST_CACHE_CONFIG,
        cacheableContentsTokenCount: 75000,
      };

      const result = await internals(manager).createNewCacheWithContents(
        request,
        1,
      );

      expect(result).toBeUndefined();
      expect(caches.create).not.toHaveBeenCalled();
    });

    it('applies no client floor for opaque model IDs', async () => {
      const request = createLlmRequest({
        contentsCount: 0,
        model: 'projects/test/locations/us-central1/endpoints/tuned-model',
      });
      request.config!.systemInstruction = 'x'.repeat(12000);
      request.cacheableContentsTokenCount = 3000;
      request.cacheMetadata = createCacheMetadata({
        fingerprint: internals(manager).generateCacheFingerprint(request, 0),
        contentsCount: 0,
      });
      caches.create.mockResolvedValue({name: 'cachedContents/tuned-model'});

      const result = await manager.handleContextCaching(request);

      expect(result?.cacheName).toBe('cachedContents/tuned-model');
      expect(caches.create).toHaveBeenCalledOnce();
    });

    it('does not create a cache without a previous token count', async () => {
      const firstRequest = createLlmRequest({contentsCount: 3});
      const first = await manager.handleContextCaching(firstRequest);

      const secondRequest = createLlmRequest({
        cacheMetadata: first,
        contentsCount: 3,
      });
      // No cacheableContentsTokenCount set.
      const second = await manager.handleContextCaching(secondRequest);

      expect(second?.cacheName).toBeUndefined();
      expect(caches.create).not.toHaveBeenCalled();
    });

    it('does not create a cache below the configured minTokens', async () => {
      const config = createContextCacheConfig({minTokens: 2048});
      const firstRequest = createLlmRequest({
        contentsCount: 3,
        cacheConfig: config,
      });
      const first = await manager.handleContextCaching(firstRequest);

      const secondRequest = createLlmRequest({
        cacheMetadata: first,
        contentsCount: 3,
        cacheConfig: config,
      });
      secondRequest.cacheableContentsTokenCount = 1024;
      const second = await manager.handleContextCaching(secondRequest);

      expect(second?.cacheName).toBeUndefined();
      expect(caches.create).not.toHaveBeenCalled();
    });

    it('uses the default minTokens when cacheConfig omits it', async () => {
      const request = createLlmRequest({contentsCount: 0});
      request.config!.systemInstruction = 'x'.repeat(12000);
      request.cacheConfig = {}; // Partial config: minTokens defaults to 0.
      request.cacheableContentsTokenCount = 3000;
      caches.create.mockResolvedValue({name: 'cachedContents/default-min'});

      const result = await internals(manager).createNewCacheWithContents(
        request,
        0,
      );

      expect(result?.cacheName).toBe('cachedContents/default-min');
    });

    it('returns fingerprint-only metadata when cache creation fails', async () => {
      caches.create.mockRejectedValue(new Error('boom'));
      const firstRequest = createLlmRequest({contentsCount: 0});
      firstRequest.config!.systemInstruction = 'x'.repeat(12000);
      const first = await manager.handleContextCaching(firstRequest);

      const secondRequest = createLlmRequest({
        cacheMetadata: first,
        contentsCount: 0,
      });
      secondRequest.config!.systemInstruction = 'x'.repeat(12000);
      secondRequest.cacheableContentsTokenCount = 3000;

      const second = await manager.handleContextCaching(secondRequest);

      expect(caches.create).toHaveBeenCalledOnce();
      expect(second?.cacheName).toBeUndefined();
      expect(second?.contentsCount).toBe(0);
    });
  });

  describe('reuse across turns', () => {
    it('reuses a valid active cache as a copy without a create call', async () => {
      const request = createLlmRequest({contentsCount: 3});
      const fingerprint = internals(manager).generateCacheFingerprint(
        request,
        2,
      );
      const existing = createCacheMetadata({
        cacheName: 'projects/test/locations/us-central1/cachedContents/test123',
        expireTime: nowSeconds() + 1800,
        fingerprint,
        invocationsUsed: 5,
        contentsCount: 2,
        createdAt: nowSeconds() - 600,
      });
      request.cacheMetadata = existing;

      const result = await manager.handleContextCaching(request);

      expect(result?.cacheName).toBe(existing.cacheName);
      expect(result?.invocationsUsed).toBe(5);
      expect(result?.expireTime).toBe(existing.expireTime);
      expect(result).not.toBe(existing);
      expect(caches.create).not.toHaveBeenCalled();
      // The request was mutated to reference the cache.
      expect(request.config?.systemInstruction).toBeUndefined();
      expect(request.config?.tools).toBeUndefined();
      expect(request.config?.toolConfig).toBeUndefined();
      expect(request.config?.cachedContent).toBe(existing.cacheName);
      expect(request.contents).toHaveLength(1);
    });

    it('transitions from fingerprint-only metadata to an active cache on turn 2', async () => {
      const request1 = createLlmRequest({contentsCount: 3});
      const result1 = await manager.handleContextCaching(request1);
      expect(result1?.cacheName).toBeUndefined();
      expect(result1?.contentsCount).toBe(0);

      const request2 = createLlmRequest({
        cacheMetadata: result1,
        contentsCount: 5,
      });
      request2.cacheableContentsTokenCount = 30000;
      expect(
        internals(manager).generateCacheFingerprint(
          request2,
          result1!.contentsCount,
        ),
      ).toBe(result1!.fingerprint);
      caches.create.mockResolvedValue({
        name: 'projects/test/locations/us-central1/cachedContents/new789',
      });

      const result2 = await manager.handleContextCaching(request2);

      expect(result2?.cacheName).toBe(
        'projects/test/locations/us-central1/cachedContents/new789',
      );
      expect(result2?.contentsCount).toBe(0);
      expect(result2?.invocationsUsed).toBe(1);
      expect(caches.create).toHaveBeenCalledOnce();
      expect(caches.create.mock.calls[0][0].config.contents).toBeUndefined();
    });

    it('grows the cached prefix after a completed turn', async () => {
      const firstUser = userContent('First question');
      const firstModel = modelContent('First answer');
      const nextUser = userContent('Next question');

      const firstRequest = createLlmRequest({contentsCount: 0});
      firstRequest.contents = [firstUser];
      const firstMeta = await manager.handleContextCaching(firstRequest);
      expect(firstMeta?.contentsCount).toBe(0);

      const nextRequest = createLlmRequest({
        cacheMetadata: firstMeta,
        contentsCount: 0,
      });
      nextRequest.contents = [firstUser, firstModel, nextUser];
      nextRequest.cacheableContentsTokenCount = 30000;
      caches.create.mockResolvedValue({name: 'cachedContents/grown-prefix'});

      const nextMeta = await manager.handleContextCaching(nextRequest);

      expect(nextMeta?.cacheName).toBe('cachedContents/grown-prefix');
      expect(nextMeta?.contentsCount).toBe(2);
      expect(caches.create.mock.calls[0][0].config.contents).toEqual([
        firstUser,
        firstModel,
      ]);
      expect(nextRequest.contents).toEqual([nextUser]);
    });

    it('keeps request-scoped dynamic instructions out of the cached prefix', async () => {
      const dynamicInstruction = userContent('Turn context: locale=en-US');
      const userMsg = userContent('what time is it?');
      const modelToolCall = modelCall('get_time', {});
      const toolResp = toolResponse('get_time', {time: '12:00'});

      const request1 = createLlmRequest({contentsCount: 0});
      request1.contents = [dynamicInstruction, userMsg];
      const result1 = await manager.handleContextCaching(request1);
      expect(result1?.cacheName).toBeUndefined();
      expect(result1?.contentsCount).toBe(0);

      const request2 = createLlmRequest({
        cacheMetadata: result1,
        contentsCount: 0,
      });
      request2.contents = [
        userMsg,
        modelToolCall,
        dynamicInstruction,
        toolResp,
      ];
      request2.cacheableContentsTokenCount = 30000;
      caches.create.mockResolvedValue({name: 'cachedContents/dynamic'});

      const result2 = await manager.handleContextCaching(request2);

      expect(result2?.cacheName).toBe('cachedContents/dynamic');
      expect(result2?.contentsCount).toBe(2);
      expect(caches.create.mock.calls[0][0].config.contents).toEqual([
        userMsg,
        modelToolCall,
      ]);
    });

    it('returns fingerprint-only metadata when there is no existing cache', async () => {
      const request = createLlmRequest({contentsCount: 5});
      const result = await manager.handleContextCaching(request);
      expect(result?.cacheName).toBeUndefined();
      expect(result?.contentsCount).toBe(0);
      expect(caches.create).not.toHaveBeenCalled();
    });
  });

  describe('expiry / invalidation', () => {
    it('recreates the cache when an invalid cache still matches the fingerprint', async () => {
      const request = createLlmRequest({contentsCount: 3});
      request.cacheableContentsTokenCount = 5000;
      const fingerprint = internals(manager).generateCacheFingerprint(
        request,
        2,
      );
      const existing = createCacheMetadata({
        cacheName: 'projects/test/locations/us-central1/cachedContents/old',
        expireTime: nowSeconds() - 300, // expired
        fingerprint,
        invocationsUsed: 5,
        contentsCount: 2,
        createdAt: nowSeconds() - 600,
      });
      request.cacheMetadata = existing;
      caches.create.mockResolvedValue({name: 'cachedContents/new456'});

      const result = await manager.handleContextCaching(request);

      expect(caches.delete).toHaveBeenCalledWith({name: existing.cacheName});
      expect(result?.cacheName).toBe('cachedContents/new456');
      expect(caches.create).toHaveBeenCalledOnce();
    });

    it('returns fingerprint-only metadata when an invalid cache no longer matches', async () => {
      const request = createLlmRequest({contentsCount: 5});
      const existing = createCacheMetadata({
        cacheName: 'projects/test/locations/us-central1/cachedContents/old',
        expireTime: nowSeconds() - 300,
        fingerprint: 'does-not-match',
        invocationsUsed: 5,
        contentsCount: 3,
        createdAt: nowSeconds() - 600,
      });
      request.cacheMetadata = existing;

      const result = await manager.handleContextCaching(request);

      expect(caches.delete).toHaveBeenCalledWith({name: existing.cacheName});
      expect(result?.cacheName).toBeUndefined();
      expect(result?.contentsCount).toBe(0);
      expect(caches.create).not.toHaveBeenCalled();
    });

    it('invalidates and deletes the old cache when the model changes', async () => {
      const flashRequest = createLlmRequest({contentsCount: 0});
      const flashMeta = await manager.handleContextCaching(flashRequest);
      const active = createCacheMetadata({
        cacheName: 'cachedContents/flash-cache',
        expireTime: nowSeconds() + 1800,
        fingerprint: flashMeta!.fingerprint,
        invocationsUsed: 1,
        contentsCount: flashMeta!.contentsCount,
        createdAt: nowSeconds(),
      });
      const proRequest = createLlmRequest({
        cacheMetadata: active,
        contentsCount: 0,
        model: 'gemini-2.5-pro',
      });

      const proMeta = await manager.handleContextCaching(proRequest);

      expect(proMeta?.cacheName).toBeUndefined();
      expect(proMeta?.fingerprint).not.toBe(active.fingerprint);
      expect(caches.delete).toHaveBeenCalledWith({
        name: 'cachedContents/flash-cache',
      });
    });

    it('invalidates and deletes the old cache when the backend changes', async () => {
      const developerRequest = createLlmRequest({contentsCount: 0});
      const developerMeta =
        await manager.handleContextCaching(developerRequest);
      const active = createCacheMetadata({
        cacheName: 'cachedContents/developer-cache',
        expireTime: nowSeconds() + 1800,
        fingerprint: developerMeta!.fingerprint,
        invocationsUsed: 1,
        contentsCount: developerMeta!.contentsCount,
        createdAt: nowSeconds(),
      });
      const {client: vertexClient, caches: vertexCaches} = makeClient(true);
      const vertexManager = new GeminiContextCacheManager(vertexClient);
      const vertexRequest = createLlmRequest({
        cacheMetadata: active,
        contentsCount: 0,
      });

      const vertexMeta =
        await vertexManager.handleContextCaching(vertexRequest);

      expect(vertexMeta?.cacheName).toBeUndefined();
      expect(vertexMeta?.fingerprint).not.toBe(active.fingerprint);
      expect(vertexCaches.delete).toHaveBeenCalledWith({
        name: 'cachedContents/developer-cache',
      });
    });

    describe('isCacheValid', () => {
      const activeMeta = (
        request: LlmRequest,
        overrides: Partial<CacheMetadata> = {},
      ): CacheMetadata =>
        createCacheMetadata({
          cacheName: 'projects/test/locations/us-central1/cachedContents/v',
          expireTime: nowSeconds() + 1800,
          fingerprint: internals(manager).generateCacheFingerprint(
            request,
            overrides.contentsCount ?? 2,
          ),
          invocationsUsed: 5,
          contentsCount: 2,
          ...overrides,
        });

      it('is false when there is no cache metadata', () => {
        const request = createLlmRequest();
        request.cacheMetadata = undefined;
        expect(internals(manager).isCacheValid(request)).toBe(false);
      });

      it('is false for fingerprint-only metadata', () => {
        const request = createLlmRequest();
        request.cacheMetadata = createCacheMetadata({
          fingerprint: 'fp',
          contentsCount: 5,
        });
        expect(internals(manager).isCacheValid(request)).toBe(false);
      });

      it('is false for an expired cache', () => {
        const request = createLlmRequest();
        request.cacheMetadata = activeMeta(request, {
          expireTime: nowSeconds() - 1,
        });
        expect(internals(manager).isCacheValid(request)).toBe(false);
      });

      it('is false when the invocation budget is exceeded', () => {
        const request = createLlmRequest();
        request.cacheMetadata = activeMeta(request, {invocationsUsed: 15});
        expect(internals(manager).isCacheValid(request)).toBe(false);
      });

      it('is false on a fingerprint mismatch', () => {
        const request = createLlmRequest();
        request.cacheMetadata = createCacheMetadata({
          cacheName: 'projects/test/locations/us-central1/cachedContents/v',
          expireTime: nowSeconds() + 1800,
          fingerprint: 'stale-fingerprint',
          invocationsUsed: 5,
          contentsCount: 2,
        });
        expect(internals(manager).isCacheValid(request)).toBe(false);
      });

      it('is true when all checks pass', () => {
        const request = createLlmRequest();
        request.cacheMetadata = activeMeta(request);
        expect(internals(manager).isCacheValid(request)).toBe(true);
      });

      it('falls back to the default invocation budget when cacheConfig omits cacheIntervals', () => {
        const request = createLlmRequest();
        request.cacheConfig = {}; // Partial config: cacheIntervals defaults to 10.
        request.cacheMetadata = createCacheMetadata({
          cacheName: 'projects/test/locations/us-central1/cachedContents/v',
          expireTime: nowSeconds() + 1800,
          fingerprint: internals(manager).generateCacheFingerprint(request, 2),
          invocationsUsed: 5,
          contentsCount: 2,
        });
        expect(internals(manager).isCacheValid(request)).toBe(true);
      });
    });

    describe('createGeminiCache', () => {
      it('uses the server-reported expiry when available', async () => {
        const iso = '2033-05-18T03:33:20.000Z';
        caches.create.mockResolvedValue({
          name: 'cachedContents/test123',
          expireTime: iso,
        });
        const request = createLlmRequest();

        const meta = await internals(manager).createGeminiCache(request, 2);

        expect(meta.expireTime).toBe(Date.parse(iso) / 1000);
      });

      it('falls back to created-at plus ttl when the server omits expiry', async () => {
        caches.create.mockResolvedValue({name: 'cachedContents/test123'});
        const request = createLlmRequest();

        const meta = await internals(manager).createGeminiCache(request, 2);

        expect(meta.expireTime!).toBeGreaterThan(nowSeconds() + 1700);
        expect(meta.expireTime!).toBeLessThan(nowSeconds() + 1900);
      });

      it('falls back to computed expiry when the server expiry is unparseable', async () => {
        caches.create.mockResolvedValue({
          name: 'cachedContents/test123',
          expireTime: 'not-a-date',
        });
        const request = createLlmRequest();

        const meta = await internals(manager).createGeminiCache(request, 2);

        expect(meta.expireTime!).toBeGreaterThan(nowSeconds() + 1700);
        expect(meta.expireTime!).toBeLessThan(nowSeconds() + 1900);
      });

      it('passes ttl, prefix contents, and a display name to caches.create', async () => {
        caches.create.mockResolvedValue({name: 'cachedContents/test123'});
        const request = createLlmRequest({contentsCount: 3});

        await internals(manager).createGeminiCache(request, 2);

        const config = caches.create.mock.calls[0][0].config;
        expect(config.ttl).toBe('1800s');
        expect(config.contents).toHaveLength(2);
        expect(config.displayName).toMatch(/^adk-cache-\d+-2contents$/);
        expect(config.systemInstruction).toBe('Test instruction');
        expect(config.tools).toBeDefined();
        expect(config.toolConfig).toBeDefined();
      });

      it('sends undefined contents when the prefix is empty', async () => {
        caches.create.mockResolvedValue({name: 'cachedContents/test123'});
        const request = createLlmRequest({contentsCount: 3});

        await internals(manager).createGeminiCache(request, 0);

        expect(caches.create.mock.calls[0][0].config.contents).toBeUndefined();
      });

      it('omits system instruction, tools, and tool config when absent', async () => {
        caches.create.mockResolvedValue({name: 'cachedContents/test123'});
        const request: LlmRequest = {
          model: 'gemini-2.5-flash',
          contents: [userContent('hi')],
          config: {},
          liveConnectConfig: {},
          toolsDict: {},
          cacheConfig: TEST_CACHE_CONFIG,
        };

        await internals(manager).createGeminiCache(request, 0);

        const config = caches.create.mock.calls[0][0].config;
        expect(config.systemInstruction).toBeUndefined();
        expect(config.tools).toBeUndefined();
        expect(config.toolConfig).toBeUndefined();
        expect(config.httpOptions).toBeUndefined();
      });

      it('falls back to the default ttl when the request has no cacheConfig', async () => {
        caches.create.mockResolvedValue({name: 'cachedContents/no-config'});
        const request: LlmRequest = {
          model: 'gemini-2.5-flash',
          contents: [userContent('hi')],
          config: {},
          liveConnectConfig: {},
          toolsDict: {},
        };

        await internals(manager).createGeminiCache(request, 0);

        expect(caches.create.mock.calls[0][0].config.ttl).toBe('1800s');
      });

      it('passes createHttpOptions through when present', async () => {
        caches.create.mockResolvedValue({name: 'cachedContents/test123'});
        const request = createLlmRequest({
          cacheConfig: createContextCacheConfig({
            createHttpOptions: {timeout: 10000},
          }),
        });

        await internals(manager).createGeminiCache(request, 2);

        const config = caches.create.mock.calls[0][0].config;
        expect(config.httpOptions.timeout).toBe(10000);
      });
    });

    describe('cleanupCache', () => {
      it('deletes the cache by name', async () => {
        await manager.cleanupCache('cachedContents/test123');
        expect(caches.delete).toHaveBeenCalledWith({
          name: 'cachedContents/test123',
        });
      });

      it('swallows delete errors', async () => {
        caches.delete.mockRejectedValue(new Error('boom'));
        await expect(
          manager.cleanupCache('cachedContents/test123'),
        ).resolves.toBeUndefined();
      });
    });

    describe('populateCacheMetadataInResponse', () => {
      it('copies the metadata onto the response', () => {
        const meta = createCacheMetadata({
          cacheName: 'cachedContents/test123',
          expireTime: nowSeconds() + 1800,
          fingerprint: 'fp',
          invocationsUsed: 3,
          contentsCount: 2,
        });
        const response: LlmResponse = {};

        manager.populateCacheMetadataInResponse(response, meta);

        expect(response.cacheMetadata).toEqual(meta);
        expect(response.cacheMetadata).not.toBe(meta);
      });
    });

    describe('cacheScope', () => {
      it('includes project, location, and base URL for a Vertex client', () => {
        const vertexClient = {
          caches: {create: vi.fn(), delete: vi.fn()},
          vertexai: true,
          apiClient: {
            getProject: () => 'proj',
            getLocation: () => 'loc',
            getBaseUrl: () => 'https://base',
          },
        } as unknown as GoogleGenAI;
        const scope = internals(
          new GeminiContextCacheManager(vertexClient),
        ).cacheScope();
        expect(scope).toEqual({
          backend: 'vertex',
          project: 'proj',
          location: 'loc',
          baseUrl: 'https://base',
        });
      });

      it('reports only the backend for a Developer API client', () => {
        expect(internals(manager).cacheScope()).toEqual({backend: 'gemini'});
      });

      it('tolerates a Vertex client without scope accessors', () => {
        const vertexClient = {
          caches: {create: vi.fn(), delete: vi.fn()},
          vertexai: true,
          apiClient: {},
        } as unknown as GoogleGenAI;
        const scope = internals(
          new GeminiContextCacheManager(vertexClient),
        ).cacheScope();
        expect(scope.backend).toBe('vertex');
        expect(scope.project).toBeUndefined();
        expect(scope.location).toBeUndefined();
        expect(scope.baseUrl).toBeUndefined();
      });
    });
  });

  describe('standalone helpers', () => {
    it('minimumCacheTokens resolves documented floors', () => {
      expect(GEMINI_2_5_MIN_CACHE_TOKENS).toBe(2048);
      expect(GEMINI_3_MIN_CACHE_TOKENS).toBe(4096);
      expect(minimumCacheTokens('gemini-2.5-flash')).toBe(2048);
      expect(minimumCacheTokens('gemini-2.5-pro')).toBe(2048);
      expect(minimumCacheTokens('gemini-3.1-pro-preview')).toBe(4096);
      expect(
        minimumCacheTokens(
          'projects/p/locations/l/publishers/google/models/gemini-2.5-flash',
        ),
      ).toBe(2048);
      expect(
        minimumCacheTokens('projects/p/locations/l/endpoints/tuned'),
      ).toBeUndefined();
      expect(minimumCacheTokens('gemini-1.5-flash')).toBeUndefined();
      expect(minimumCacheTokens(undefined)).toBeUndefined();
      expect(minimumCacheTokens('')).toBeUndefined();
    });

    it('findCountOfContentsToCache counts the stable prefix', () => {
      expect(findCountOfContentsToCache([])).toBe(0);
      expect(
        findCountOfContentsToCache([
          userContent('a'),
          userContent('b'),
          userContent('c'),
        ]),
      ).toBe(0);

      const user = userContent('Find weather and news');
      const call1 = modelCall('get_weather', {city: 'NYC'});
      const resp1 = toolResponse('get_weather', {temp: '72F'});
      const call2 = modelCall('get_news', {topic: 'tech'});
      const resp2 = toolResponse('get_news', {headline: 'AI advances'});
      const finalModel = modelContent('Weather is 72F, news: AI advances');

      expect(findCountOfContentsToCache([user])).toBe(0);
      expect(findCountOfContentsToCache([user, call1, resp1])).toBe(2);
      expect(
        findCountOfContentsToCache([user, call1, resp1, call2, resp2]),
      ).toBe(4);
      expect(
        findCountOfContentsToCache([
          user,
          call1,
          resp1,
          call2,
          resp2,
          finalModel,
        ]),
      ).toBe(6);
    });

    it('estimateRequestTokens counts the request or its prefix', () => {
      const request = createLlmRequest({contentsCount: 3});
      const full = estimateRequestTokens(request);
      const prefix = estimateRequestTokens(request, 1);
      expect(full).toBeGreaterThan(prefix);

      const objectInstruction: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {
          systemInstruction: {role: 'user', parts: [{text: 'hello there'}]},
        },
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(estimateRequestTokens(objectInstruction)).toBeGreaterThan(0);

      const empty: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(estimateRequestTokens(empty)).toBe(0);

      const partless: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user'}],
        config: {systemInstruction: 'hi'},
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(estimateRequestTokens(partless)).toBe(0);
    });

    it('estimateCacheablePrefixTokens scales the accurate token count', () => {
      const noCount = createLlmRequest();
      expect(estimateCacheablePrefixTokens(noCount, 2)).toBe(0);

      const noText: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [],
        config: {},
        liveConnectConfig: {},
        toolsDict: {},
        cacheableContentsTokenCount: 500,
      };
      expect(estimateCacheablePrefixTokens(noText, 0)).toBe(500);

      const request = createLlmRequest({contentsCount: 4});
      request.cacheableContentsTokenCount = 1000;
      const estimate = estimateCacheablePrefixTokens(request, 2);
      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThanOrEqual(1000);
    });

    it('canonicalJson sorts object keys deeply and compactly', () => {
      expect(canonicalJson({b: 1, a: 2})).toBe('{"a":2,"b":1}');
      expect(canonicalJson({z: {y: 1, x: 2}, a: [3, {d: 4, c: 5}]})).toBe(
        '{"a":[3,{"c":5,"d":4}],"z":{"x":2,"y":1}}',
      );
      expect(canonicalJson('str')).toBe('"str"');
      expect(canonicalJson(42)).toBe('42');
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson([2, 1])).toBe('[2,1]');
    });

    it('applyCacheToRequest strips cached fields and prefix', () => {
      const request = createLlmRequest({contentsCount: 3});
      applyCacheToRequest(request, 'cachedContents/x', 2);
      expect(request.config?.systemInstruction).toBeUndefined();
      expect(request.config?.tools).toBeUndefined();
      expect(request.config?.toolConfig).toBeUndefined();
      expect(request.config?.cachedContent).toBe('cachedContents/x');
      expect(request.contents).toHaveLength(1);

      const noConfig: LlmRequest = {
        model: 'gemini-2.5-flash',
        contents: [userContent('a'), userContent('b')],
        liveConnectConfig: {},
        toolsDict: {},
      };
      applyCacheToRequest(noConfig, 'cachedContents/y', 1);
      expect(noConfig.config?.cachedContent).toBe('cachedContents/y');
      expect(noConfig.contents).toHaveLength(1);
    });
  });
});
