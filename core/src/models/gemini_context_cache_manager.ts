/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CachedContent,
  Content,
  ContentUnion,
  CreateCachedContentConfig,
  CreateCachedContentParameters,
  DeleteCachedContentParameters,
  DeleteCachedContentResponse,
  Tool,
  ToolUnion,
} from '@google/genai';

import {ContextCacheConfig} from '../agents/context_cache_config.js';
import {tracer} from '../telemetry/tracing.js';
import {canonicalJson, stableDigest} from '../utils/digest_utils.js';
import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {ActiveCacheMetadata, CacheMetadata} from './cache_metadata.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * Explicit-cache token floor for the `gemini-2.5-*` family, as published in
 * the Gemini context-caching documentation.
 */
const GEMINI_2_5_MIN_CACHE_TOKENS = 2048;

/** Explicit-cache token floor for the `gemini-3*` family. */
const GEMINI_3_MIN_CACHE_TOKENS = 4096;

/** Characters per token used by the rough request-size estimate. */
const CHARACTERS_PER_TOKEN = 4;

/**
 * The subset of a `@google/genai` client that context caching uses.
 *
 * A `GoogleGenAI` instance satisfies it, and declaring only what the manager
 * calls lets a test supply a plain object without an unchecked cast.
 */
export interface CacheClient {
  /** Whether the client talks to Vertex AI rather than the Gemini API. */
  readonly vertexai: boolean;

  /** The explicit-cache resource operations. */
  readonly caches: {
    create(params: CreateCachedContentParameters): Promise<CachedContent>;
    delete(
      params: DeleteCachedContentParameters,
    ): Promise<DeleteCachedContentResponse>;
  };
}

/**
 * The backend namespace that owns explicit cache resources.
 *
 * A cache created in one namespace cannot be read from another, so these
 * fields are part of the cache's compatibility boundary.
 */
export interface CacheScope {
  /** The Vertex AI project that owns the cache. */
  readonly project?: string;

  /** The Vertex AI location that owns the cache. */
  readonly location?: string;

  /** The API base URL the cache was created against. */
  readonly baseUrl?: string;
}

/** A {@link CacheScope} qualified by the backend the client talks to. */
export interface QualifiedCacheScope extends CacheScope {
  readonly backend: 'vertex' | 'gemini';
}

/**
 * Returns the declarative tools of a request's tool list.
 *
 * A `CallableTool` is the only other arm of {@link ToolUnion} and it is
 * identified by its `callTool` method, so no `instanceof` check is needed.
 */
function declarativeTools(tools: ToolUnion[] | undefined): Tool[] {
  return (tools ?? []).filter((tool): tool is Tool => !('callTool' in tool));
}

function requireCacheConfig(llmRequest: LlmRequest): ContextCacheConfig {
  if (!llmRequest.cacheConfig) {
    throw new Error('Context caching requires a cache configuration.');
  }
  return llmRequest.cacheConfig;
}

function requireModel(llmRequest: LlmRequest): string {
  if (!llmRequest.model) {
    throw new Error('Context caching requires a model name.');
  }
  return llmRequest.model;
}

/** Returns a stable rough size for a system-instruction value. */
function contentUnionCharacterCount(value: ContentUnion): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) =>
        total +
        (typeof item === 'string' ? item.length : JSON.stringify(item).length),
      0,
    );
  }
  return JSON.stringify(value).length;
}

/**
 * Returns the number of leading contents that may be cached.
 *
 * The strategy is to cache everything before the last continuous batch of
 * user contents, so the request always keeps a user turn to send. The result
 * is `contents.length` when the last content is not a user content, and `0`
 * when every content is a user content.
 *
 * @param contents The request contents, oldest first.
 * @returns The count of leading contents that may be cached.
 */
export function findCountOfContentsToCache(contents: Content[]): number {
  let lastUserBatchStart = contents.length;
  for (let index = contents.length - 1; index >= 0; index--) {
    if (contents[index].role !== 'user') {
      break;
    }
    lastUserBatchStart = index;
  }
  return lastUserBatchStart;
}

/**
 * Returns the tools of a request in an order-independent form.
 *
 * A reordered tool list, or a reordered function-declaration list within a
 * tool, must not invalidate a cache. The sorts run on copies, so the caller's
 * request keeps its own order.
 */
function canonicalTools(tools: ToolUnion[]): Tool[] {
  return declarativeTools(tools)
    .map((tool) =>
      tool.functionDeclarations
        ? {
            ...tool,
            functionDeclarations: [...tool.functionDeclarations].sort(
              (left, right) => compareText(left.name ?? '', right.name ?? ''),
            ),
          }
        : tool,
    )
    .map((tool) => ({tool, key: canonicalJson(tool)}))
    .sort((left, right) => compareText(left.key, right.key))
    .map(({tool}) => tool);
}

/** Orders two texts by code unit, so the result does not depend on a locale. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Returns a fingerprint of everything an explicit cache would hold.
 *
 * A cache is only reusable while the model, the backend namespace, the system
 * instruction, the tools, the tool config and the cached content prefix are
 * all unchanged, so the fingerprint covers exactly those.
 *
 * @param llmRequest The request to fingerprint.
 * @param cacheContentsCount The number of leading contents the cache covers.
 * @param cacheScope The backend namespace that owns the cache.
 * @returns A short hexadecimal digest of the cacheable state.
 */
export async function generateCacheFingerprint(
  llmRequest: LlmRequest,
  cacheContentsCount: number,
  cacheScope: QualifiedCacheScope,
): Promise<string> {
  const config = llmRequest.config;
  const contents = llmRequest.contents;
  return stableDigest({
    model: llmRequest.model,
    cacheScope,
    systemInstruction: config?.systemInstruction,
    tools: config?.tools?.length ? canonicalTools(config.tools) : undefined,
    toolConfig: config?.toolConfig,
    cachedContents:
      cacheContentsCount > 0 && contents.length
        ? contents.slice(0, Math.min(cacheContentsCount, contents.length))
        : undefined,
  });
}

/**
 * Estimates the token count of a request, or of its cacheable prefix.
 *
 * The estimate is characters divided by {@link CHARACTERS_PER_TOKEN}. It is
 * only ever compared against another estimate of the same request, so its
 * absolute accuracy does not matter.
 *
 * @param llmRequest The request to measure.
 * @param cacheContentsCount When given, only the first `cacheContentsCount`
 *     contents are counted. The system instruction and the tools are always
 *     counted, because a cache always holds them.
 * @returns The estimated token count.
 */
export function estimateRequestTokens(
  llmRequest: LlmRequest,
  cacheContentsCount?: number,
): number {
  const config = llmRequest.config;
  let totalCharacters = 0;

  if (config?.systemInstruction) {
    totalCharacters += contentUnionCharacterCount(config.systemInstruction);
  }
  for (const tool of declarativeTools(config?.tools)) {
    totalCharacters += JSON.stringify(tool).length;
  }
  const contents = llmRequest.contents.slice(
    0,
    cacheContentsCount ?? llmRequest.contents.length,
  );
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      totalCharacters += part.text?.length ?? 0;
    }
  }
  return Math.floor(totalCharacters / CHARACTERS_PER_TOKEN);
}

/**
 * Estimates the token count of the prefix that a cache would actually hold.
 *
 * The only measured count available is `cacheableContentsTokenCount`, which
 * covers the whole previous prompt. A cache holds just the prefix, so that
 * count is scaled by the prefix's estimated share of the request.
 *
 * @param llmRequest The request carrying the measured previous prompt size.
 * @param cacheContentsCount The number of leading contents the cache covers.
 * @returns The estimated token count of the cacheable prefix.
 */
export function estimateCacheablePrefixTokens(
  llmRequest: LlmRequest,
  cacheContentsCount: number,
): number {
  const fullTokens = llmRequest.cacheableContentsTokenCount;
  if (!fullTokens) {
    return 0;
  }
  const fullEstimate = estimateRequestTokens(llmRequest);
  if (fullEstimate <= 0) {
    // Nothing to scale by, for example a request whose parts hold no text.
    // The measured count is a better answer than skipping the cache.
    return fullTokens;
  }
  const prefixEstimate = estimateRequestTokens(llmRequest, cacheContentsCount);
  return Math.trunc(fullTokens * Math.min(1, prefixEstimate / fullEstimate));
}

/**
 * Returns the explicit-cache token floor for a named Gemini model.
 *
 * An opaque tuned-model or endpoint ID gets no floor, so the server stays
 * authoritative rather than a guess blocking a cache that would succeed.
 *
 * @param model The model name, which may be a full resource path.
 * @returns The floor in tokens, or `undefined` when the model is not a named
 *     Gemini family member.
 */
export function minimumCacheTokens(model?: string): number | undefined {
  const modelName = (model ?? '').replace(/^.*\//, '');
  if (modelName.startsWith('gemini-2.5-')) {
    return GEMINI_2_5_MIN_CACHE_TOKENS;
  }
  if (modelName.startsWith('gemini-3')) {
    return GEMINI_3_MIN_CACHE_TOKENS;
  }
  return undefined;
}

/**
 * Rewrites a request to read its cacheable prefix from a cache.
 *
 * The system instruction, the tools and the tool config move into the cache,
 * so they are cleared here. The final content is always kept, because the API
 * rejects a request with no contents.
 *
 * @param llmRequest The request to rewrite in place.
 * @param cacheName The full resource name of the cache.
 * @param cacheContentsCount The number of leading contents the cache covers.
 */
export function applyCacheToRequest(
  llmRequest: LlmRequest,
  cacheName: string,
  cacheContentsCount: number,
): void {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  llmRequest.config.systemInstruction = undefined;
  llmRequest.config.tools = undefined;
  llmRequest.config.toolConfig = undefined;
  llmRequest.config.cachedContent = cacheName;

  const removableCount = Math.min(
    cacheContentsCount,
    Math.max(llmRequest.contents.length - 1, 0),
  );
  llmRequest.contents = llmRequest.contents.slice(removableCount);
}

/**
 * Returns a request's cache metadata when the cache it names may still be
 * used, and `undefined` otherwise.
 *
 * Only the active arm of {@link CacheMetadata} names a cache; fingerprint-only
 * metadata records a prefix, not a live cache.
 *
 * @param llmRequest The request carrying the metadata to check.
 * @param cacheScope The backend namespace that owns the cache.
 * @throws Error If the request carries no cache configuration.
 */
export async function validActiveCache(
  llmRequest: LlmRequest,
  cacheScope: QualifiedCacheScope,
): Promise<ActiveCacheMetadata | undefined> {
  const cacheMetadata = llmRequest.cacheMetadata;
  if (cacheMetadata?.cacheName === undefined) {
    return undefined;
  }
  const {cacheName, expireTime, invocationsUsed} = cacheMetadata;
  const cacheConfig = requireCacheConfig(llmRequest);

  if (Date.now() / 1000 >= expireTime) {
    logger.info(`Cache expired: ${cacheName}`);
    return undefined;
  }
  if (invocationsUsed > cacheConfig.cacheIntervals) {
    logger.info(
      `Cache exceeded cache intervals: ${cacheName} (${invocationsUsed} > ` +
        `${cacheConfig.cacheIntervals} intervals)`,
    );
    return undefined;
  }
  const currentFingerprint = await generateCacheFingerprint(
    llmRequest,
    cacheMetadata.contentsCount,
    cacheScope,
  );
  if (currentFingerprint !== cacheMetadata.fingerprint) {
    logger.debug('Cache content fingerprint mismatch');
    return undefined;
  }
  return cacheMetadata;
}

/**
 * Resolves the cache expiry, in Unix seconds.
 *
 * The server reports an RFC 3339 timestamp. When it is missing or unparsable,
 * the requested time to live applied to the creation time is the best
 * available answer.
 */
function expireTimeSeconds(
  serverExpireTime: string | undefined,
  createdAt: number,
  ttlSeconds: number,
): number {
  const parsed = serverExpireTime ? Date.parse(serverExpireTime) : Number.NaN;
  return Number.isNaN(parsed) ? createdAt + ttlSeconds : parsed / 1000;
}

/** Fingerprints the request's current cacheable prefix without caching it. */
async function fingerprintOnlyMetadata(
  llmRequest: LlmRequest,
  cacheScope: QualifiedCacheScope,
): Promise<CacheMetadata> {
  const contentsCount = findCountOfContentsToCache(llmRequest.contents);
  return {
    fingerprint: await generateCacheFingerprint(
      llmRequest,
      contentsCount,
      cacheScope,
    ),
    contentsCount,
  };
}

/**
 * Manages the lifecycle of a Gemini explicit context cache.
 *
 * The manager fingerprints the cacheable prefix of a request, reuses a cache
 * while that fingerprint holds, creates a server-side cache once the prefix
 * has proved stable and is large enough, and deletes a cache that no longer
 * matches. Caching is an optimisation, so a transport failure degrades to no
 * cache rather than failing the request.
 *
 * WARNING: This feature is **experimental** and its API or behavior may
 * change in future releases.
 */
@experimental
export class GeminiContextCacheManager {
  private readonly cacheScope: QualifiedCacheScope;

  /**
   * @param genaiClient The client used for cache operations.
   * @param cacheScope The project, location and base URL that own the cache.
   *     They belong to the cache's compatibility boundary, and the client does
   *     not expose them, so the caller supplies them.
   */
  constructor(
    private readonly genaiClient: CacheClient,
    cacheScope?: CacheScope,
  ) {
    const backend = genaiClient.vertexai ? 'vertex' : 'gemini';
    this.cacheScope = {
      backend,
      project: backend === 'vertex' ? cacheScope?.project : undefined,
      location: backend === 'vertex' ? cacheScope?.location : undefined,
      baseUrl: cacheScope?.baseUrl,
    };
  }

  /**
   * Applies context caching to a request.
   *
   * A valid cache is reused. An invalid one is deleted, and a new cache is
   * created when the previous fingerprint still matches, which proves the
   * prefix has settled. Every other path only fingerprints the prefix, so the
   * next call can create a cache once the prefix repeats.
   *
   * @param llmRequest The request, rewritten in place when a cache applies.
   * @returns The metadata to record on the response.
   * @throws Error If the request carries no model or no cache configuration.
   */
  async handleContextCaching(llmRequest: LlmRequest): Promise<CacheMetadata> {
    requireModel(llmRequest);
    requireCacheConfig(llmRequest);

    const oldCacheMetadata = llmRequest.cacheMetadata;
    if (!oldCacheMetadata) {
      logger.debug('No existing cache metadata, fingerprinting the prefix');
      return fingerprintOnlyMetadata(llmRequest, this.cacheScope);
    }

    const validCache = await validActiveCache(llmRequest, this.cacheScope);
    if (validCache) {
      logger.debug(`Cache is valid, reusing cache: ${validCache.cacheName}`);
      applyCacheToRequest(
        llmRequest,
        validCache.cacheName,
        validCache.contentsCount,
      );
      return {...validCache};
    }

    if (oldCacheMetadata.cacheName !== undefined) {
      logger.debug(
        `Cache is invalid, cleaning up: ${oldCacheMetadata.cacheName}`,
      );
      await this.cleanupCache(oldCacheMetadata.cacheName);
    }

    const previousContentsCount = oldCacheMetadata.contentsCount;
    const previousFingerprint = await generateCacheFingerprint(
      llmRequest,
      previousContentsCount,
      this.cacheScope,
    );
    if (previousFingerprint !== oldCacheMetadata.fingerprint) {
      // A request-scoped content, such as a dynamic instruction, changed the
      // prefix. Restart the chain from the prefix the request has now.
      logger.debug('Fingerprints differ, fingerprinting the current prefix');
      return fingerprintOnlyMetadata(llmRequest, this.cacheScope);
    }

    const cacheContentsCount = Math.max(
      previousContentsCount,
      findCountOfContentsToCache(llmRequest.contents),
    );
    const cacheMetadata = await this.createNewCacheWithContents(
      llmRequest,
      cacheContentsCount,
    );
    if (cacheMetadata) {
      applyCacheToRequest(
        llmRequest,
        cacheMetadata.cacheName,
        cacheContentsCount,
      );
      return cacheMetadata;
    }
    // Keep the largest stable prefix, so the fingerprint does not oscillate
    // while the request stays below the size that justifies a cache.
    // Fingerprinting here rather than above keeps the created-cache path to
    // one digest, since `createGeminiCache` computes the same one itself.
    logger.debug(
      `Cache creation skipped, preserving prefix fingerprint ` +
        `(contentsCount=${cacheContentsCount})`,
    );
    return {
      fingerprint: await generateCacheFingerprint(
        llmRequest,
        cacheContentsCount,
        this.cacheScope,
      ),
      contentsCount: cacheContentsCount,
    };
  }

  /**
   * Deletes a cache. It logs a delete failure rather than raising it, because
   * a stale cache costs storage but never breaks a request.
   *
   * @param cacheName The full resource name of the cache to delete.
   */
  async cleanupCache(cacheName: string): Promise<void> {
    logger.debug(`Attempting to delete cache: ${cacheName}`);
    try {
      await this.genaiClient.caches.delete({name: cacheName});
      logger.info(`Cache cleaned up: ${cacheName}`);
    } catch (error: unknown) {
      logger.warn(
        `Failed to cleanup cache ${cacheName}: ${formatError(error)}`,
      );
    }
  }

  /**
   * Records the cache metadata that served a response.
   *
   * The use count is not incremented here. The request processor owns that
   * increment, so that one response cannot be counted twice.
   *
   * @param llmResponse The response to record the metadata on.
   * @param cacheMetadata The metadata to copy into the response.
   */
  populateCacheMetadataInResponse(
    llmResponse: LlmResponse,
    cacheMetadata: CacheMetadata,
  ): void {
    llmResponse.cacheMetadata = {...cacheMetadata};
  }

  /**
   * Creates a cache when the request is large enough to justify one.
   *
   * @returns The new cache's metadata, or `undefined` when no cache was
   *     created for any reason.
   */
  private async createNewCacheWithContents(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<ActiveCacheMetadata | undefined> {
    const cacheConfig = requireCacheConfig(llmRequest);
    const measuredTokens = llmRequest.cacheableContentsTokenCount;

    if (measuredTokens === undefined) {
      logger.info(
        'No previous token count available, skipping cache creation for the ' +
          'initial request',
      );
      return undefined;
    }
    if (measuredTokens < cacheConfig.minTokens) {
      logger.info(
        `Previous request too small for caching (${measuredTokens} < ` +
          `${cacheConfig.minTokens} tokens)`,
      );
      return undefined;
    }

    // The measured count covers the whole previous prompt, while the cache
    // holds only the prefix. On a long conversation with a short prefix, a
    // cache built on the measured count fails with 400 INVALID_ARGUMENT.
    const minimumTokens = minimumCacheTokens(llmRequest.model);
    const prefixTokens = estimateCacheablePrefixTokens(
      llmRequest,
      cacheContentsCount,
    );
    if (minimumTokens !== undefined && prefixTokens < minimumTokens) {
      logger.info(
        `Cacheable prefix below Gemini minimum cache size (${prefixTokens} ` +
          `< ${minimumTokens} tokens)`,
      );
      return undefined;
    }

    try {
      return await this.createGeminiCache(llmRequest, cacheContentsCount);
    } catch (error: unknown) {
      logger.warn(`Failed to create cache: ${formatError(error)}`);
      return undefined;
    }
  }

  /**
   * Creates the server-side cache resource.
   *
   * @throws Error If the cache service returns no cache name.
   */
  private async createGeminiCache(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<ActiveCacheMetadata> {
    const cacheRequestConfig = requireCacheConfig(llmRequest);
    const model = requireModel(llmRequest);
    const requestConfig = llmRequest.config;

    const cacheContents = llmRequest.contents.slice(0, cacheContentsCount);
    const tools = declarativeTools(requestConfig?.tools);
    const cacheConfig: CreateCachedContentConfig = {
      contents: cacheContents.length ? cacheContents : undefined,
      ttl: `${cacheRequestConfig.ttlSeconds}s`,
      displayName: `adk-cache-${Math.floor(Date.now() / 1000)}-${cacheContentsCount}contents`,
      systemInstruction: requestConfig?.systemInstruction,
      tools: tools.length ? tools : undefined,
      toolConfig: requestConfig?.toolConfig,
      httpOptions: cacheRequestConfig.createHttpOptions,
    };

    return tracer.startActiveSpan('create_cache', async (span) => {
      try {
        span.setAttribute('cache_contents_count', cacheContentsCount);
        span.setAttribute('model', model);
        span.setAttribute('ttl_seconds', cacheRequestConfig.ttlSeconds);

        const cachedContent = await this.genaiClient.caches.create({
          model,
          config: cacheConfig,
        });
        const createdAt = Date.now() / 1000;
        const cacheName = cachedContent.name;
        if (!cacheName) {
          throw new Error('The cache service returned no cache name.');
        }
        logger.info(`Cache created successfully: ${cacheName}`);
        span.setAttribute('cache_name', cacheName);

        return {
          cacheName,
          expireTime: expireTimeSeconds(
            cachedContent.expireTime,
            createdAt,
            cacheRequestConfig.ttlSeconds,
          ),
          fingerprint: await generateCacheFingerprint(
            llmRequest,
            cacheContentsCount,
            this.cacheScope,
          ),
          invocationsUsed: 1,
          contentsCount: cacheContentsCount,
          createdAt,
        };
      } finally {
        span.end();
      }
    });
  }
}
