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
} from '@google/genai';

import {ContextCacheConfig} from '../agents/context_cache_config.js';
import {tracer} from '../telemetry/tracing.js';
import {stableDigest} from '../utils/digest_utils.js';
import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {
  canonicalizeTools,
  declarativeTools,
} from '../utils/genai_tool_utils.js';
import {logger} from '../utils/logger.js';
import {
  ActiveCacheMetadata,
  CacheMetadata,
  FingerprintCacheMetadata,
} from './cache_metadata.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * Explicit-cache token floor published for the Gemini 2.5 family. A named
 * family has a documented floor; for an opaque tuned-model or endpoint ID the
 * server stays authoritative.
 */
const GEMINI_2_5_MIN_CACHE_TOKENS = 2048;

/** Explicit-cache token floor published for the Gemini 3 family. */
const GEMINI_3_MIN_CACHE_TOKENS = 4096;

/** Characters per token used by the rough size estimate. */
const CHARACTERS_PER_TOKEN = 4;

const MILLISECONDS_PER_SECOND = 1000;

/**
 * The slice of the `@google/genai` client that the cache manager uses.
 *
 * A `GoogleGenAI` instance satisfies this interface, and a test can supply a
 * plain object without a cast.
 */
export interface CacheClient {
  /** Whether the client talks to Vertex AI rather than the Gemini API. */
  readonly vertexai: boolean;

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
 * `@google/genai` does not expose the project, location or base URL its client
 * was built with, so the caller supplies them. They enter the cache
 * fingerprint, which is how a project, location or endpoint change invalidates
 * a cache created elsewhere.
 */
export interface CacheScope {
  project?: string;
  location?: string;
  baseUrl?: string;
}

/** A {@link CacheScope} with the backend the client is bound to. */
export interface QualifiedCacheScope extends CacheScope {
  backend: 'vertex' | 'gemini';
}

function requireCacheConfig(llmRequest: LlmRequest): ContextCacheConfig {
  const cacheConfig = llmRequest.cacheConfig;
  if (!cacheConfig) {
    throw new Error('Context caching requires a cache configuration.');
  }
  return cacheConfig;
}

function requireModel(llmRequest: LlmRequest): string {
  const model = llmRequest.model;
  if (!model) {
    throw new Error('Context caching requires a model name.');
  }
  return model;
}

/** Returns a stable rough size for a system-instruction value. */
function contentUnionCharacterCount(value: ContentUnion): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, item) =>
        total +
        (typeof item === 'string' ? item.length : JSON.stringify(item).length),
      0,
    );
  }
  return JSON.stringify(value).length;
}

/** Returns the metadata as an active cache, or undefined when it has none. */
function activeCacheMetadata(
  metadata: CacheMetadata,
): ActiveCacheMetadata | undefined {
  return metadata.cacheName === undefined ? undefined : metadata;
}

/** Converts the server's RFC 3339 expiry to a Unix timestamp in seconds. */
function parseExpireTime(expireTime: string | undefined): number | undefined {
  if (!expireTime) {
    return undefined;
  }
  const milliseconds = Date.parse(expireTime);
  return Number.isNaN(milliseconds)
    ? undefined
    : milliseconds / MILLISECONDS_PER_SECOND;
}

function nowInSeconds(): number {
  return Date.now() / MILLISECONDS_PER_SECOND;
}

/**
 * Returns how many leading contents are cacheable.
 *
 * The trailing run of user contents belongs to the turn in flight, so the cache
 * covers everything before it. The result is `contents.length` when the last
 * content is not a user content, and `0` when every content is one.
 *
 * @param contents The contents of the request.
 * @returns The number of leading contents that a cache may hold.
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
 * Returns a short digest of everything an explicit cache would hold.
 *
 * The digest covers the model, the backend scope, the system instruction, the
 * canonicalized tools, the tool config and the cached content prefix, and
 * nothing else. Appending a trailing turn therefore leaves a fixed-prefix
 * digest unchanged.
 *
 * @param llmRequest The request to fingerprint.
 * @param cacheContentsCount How many leading contents the cache holds.
 * @param cacheScope The backend namespace that owns the cache.
 * @returns A 16-character hexadecimal fingerprint.
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
    tools: config?.tools?.length
      ? canonicalizeTools(declarativeTools(config.tools))
      : undefined,
    toolConfig: config?.toolConfig,
    cachedContents:
      cacheContentsCount > 0 && contents.length
        ? contents.slice(0, cacheContentsCount)
        : undefined,
  });
}

/**
 * Estimates the token count of a request, or of its cacheable prefix.
 *
 * The system instruction and the tools are always counted, because a cache
 * always holds them.
 *
 * @param llmRequest The request to measure.
 * @param cacheContentsCount When given, only the first `cacheContentsCount`
 *     contents are counted.
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

  const contents =
    cacheContentsCount === undefined
      ? llmRequest.contents
      : llmRequest.contents.slice(0, cacheContentsCount);
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.text) {
        totalCharacters += part.text.length;
      }
    }
  }
  return Math.floor(totalCharacters / CHARACTERS_PER_TOKEN);
}

/**
 * Estimates the token count of the prefix that a cache would actually hold.
 *
 * The only measured count available is `cacheableContentsTokenCount`, which
 * covers the whole previous prompt. The cache holds just the prefix, so the
 * measured count is scaled by the prefix's estimated share of the request. On a
 * long conversation the full-prompt count can clear the model's floor while the
 * prefix is far below it, and creating that cache fails with 400
 * INVALID_ARGUMENT.
 *
 * @param llmRequest The request to measure.
 * @param cacheContentsCount How many leading contents the cache would hold.
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
    // No text to scale by, for example a request of non-text parts. The
    // measured count is better than denying the cache outright.
    return fullTokens;
  }
  const prefixEstimate = estimateRequestTokens(llmRequest, cacheContentsCount);
  return Math.trunc(fullTokens * Math.min(1, prefixEstimate / fullEstimate));
}

/**
 * Returns the explicit-cache token floor published for a named Gemini model.
 *
 * @param model The model name or resource path.
 * @returns The floor, or undefined when the model is not a named family and
 *     the server therefore stays authoritative.
 */
export function minimumCacheTokens(model?: string): number | undefined {
  const segments = (model ?? '').split('/');
  const modelName = segments[segments.length - 1];
  if (modelName.startsWith('gemini-2.5-')) {
    return GEMINI_2_5_MIN_CACHE_TOKENS;
  }
  if (modelName.startsWith('gemini-3')) {
    return GEMINI_3_MIN_CACHE_TOKENS;
  }
  return undefined;
}

/**
 * Rewrites the request in place to read its prefix from a cache.
 *
 * The system instruction, the tools and the tool config move into the cache, so
 * they are cleared here. The final content always survives, because the API
 * rejects a request with no contents.
 *
 * @param llmRequest The request to rewrite.
 * @param cacheName The resource name of the cache to read.
 * @param cacheContentsCount How many leading contents the cache holds.
 */
export function applyCacheToRequest(
  llmRequest: LlmRequest,
  cacheName: string,
  cacheContentsCount: number,
): void {
  // Python raises when the config is absent; initializing it is strictly safer.
  const config = (llmRequest.config ??= {});
  config.systemInstruction = undefined;
  config.tools = undefined;
  config.toolConfig = undefined;
  config.cachedContent = cacheName;

  const removableCount = Math.min(
    cacheContentsCount,
    Math.max(llmRequest.contents.length - 1, 0),
  );
  llmRequest.contents = llmRequest.contents.slice(removableCount);
}

/**
 * Returns the request's cache metadata when the cache behind it is still
 * usable, and undefined otherwise.
 *
 * @param llmRequest The request carrying the metadata to check.
 * @param cacheScope The backend namespace that owns the cache.
 * @returns The active metadata, or undefined when the cache cannot be reused.
 * @throws Error If the request carries no cache configuration.
 */
export async function validActiveCache(
  llmRequest: LlmRequest,
  cacheScope: QualifiedCacheScope,
): Promise<ActiveCacheMetadata | undefined> {
  const metadata = llmRequest.cacheMetadata;
  const activeMetadata = metadata && activeCacheMetadata(metadata);
  if (!activeMetadata) {
    return undefined;
  }
  const cacheConfig = requireCacheConfig(llmRequest);

  if (nowInSeconds() >= activeMetadata.expireTime) {
    logger.debug(`Cache expired: ${activeMetadata.cacheName}`);
    return undefined;
  }
  if (activeMetadata.invocationsUsed > cacheConfig.cacheIntervals) {
    logger.debug(
      `Cache exceeded cache intervals: ${activeMetadata.cacheName} ` +
        `(${activeMetadata.invocationsUsed} > ${cacheConfig.cacheIntervals} ` +
        'intervals)',
    );
    return undefined;
  }
  const currentFingerprint = await generateCacheFingerprint(
    llmRequest,
    activeMetadata.contentsCount,
    cacheScope,
  );
  if (currentFingerprint !== activeMetadata.fingerprint) {
    logger.debug('Cache content fingerprint mismatch');
    return undefined;
  }
  return activeMetadata;
}

/**
 * Manages the explicit context cache for Gemini models.
 *
 * On each turn the manager decides whether to reuse a live cache, delete a
 * stale one and create its replacement, or only record a fingerprint of the
 * cacheable prefix so the next turn can act on a repeat. Caching is an
 * optimization, so a transport failure degrades to "no cache" rather than
 * failing the request.
 */
@experimental
export class GeminiContextCacheManager {
  private readonly cacheScope: QualifiedCacheScope;

  /**
   * @param genaiClient The client used for cache operations.
   * @param cacheScope The project, location and base URL the client is bound
   *     to. They form part of the cache identity.
   */
  constructor(
    private readonly genaiClient: CacheClient,
    cacheScope: CacheScope = {},
  ) {
    const isVertex = genaiClient.vertexai;
    this.cacheScope = {
      backend: isVertex ? 'vertex' : 'gemini',
      project: isVertex ? cacheScope.project : undefined,
      location: isVertex ? cacheScope.location : undefined,
      baseUrl: cacheScope.baseUrl,
    };
  }

  /**
   * Applies context caching to a request and reports what it did.
   *
   * The request is modified in place when a cache applies: its system
   * instruction, tools and tool config move into the cache, `cachedContent`
   * names the cache, and the cached contents are dropped.
   *
   * @param llmRequest The request to cache, modified in place.
   * @returns The metadata to carry into the next turn. Every path returns
   *     metadata, so the next turn always has something to compare against.
   * @throws Error If the request carries no model or no cache configuration.
   */
  async handleContextCaching(llmRequest: LlmRequest): Promise<CacheMetadata> {
    requireModel(llmRequest);
    requireCacheConfig(llmRequest);

    const previousMetadata = llmRequest.cacheMetadata;
    if (!previousMetadata) {
      return this.fingerprintOnlyMetadata(
        llmRequest,
        findCountOfContentsToCache(llmRequest.contents),
      );
    }

    const reusableCache = await validActiveCache(llmRequest, this.cacheScope);
    if (reusableCache) {
      logger.debug(`Cache is valid, reusing cache: ${reusableCache.cacheName}`);
      applyCacheToRequest(
        llmRequest,
        reusableCache.cacheName,
        reusableCache.contentsCount,
      );
      return {...reusableCache};
    }

    const staleCache = activeCacheMetadata(previousMetadata);
    if (staleCache) {
      await this.cleanupCache(staleCache.cacheName);
    }

    // Check the previously fingerprinted prefix before growing it. A prefix
    // that moved, for example a request-scoped dynamic instruction, must not
    // become the base of the next cache.
    const previousContentsCount = previousMetadata.contentsCount;
    const previousPrefixFingerprint = await generateCacheFingerprint(
      llmRequest,
      previousContentsCount,
      this.cacheScope,
    );
    if (previousPrefixFingerprint !== previousMetadata.fingerprint) {
      logger.debug(
        "Fingerprints don't match, returning fingerprint-only metadata",
      );
      return this.fingerprintOnlyMetadata(
        llmRequest,
        findCountOfContentsToCache(llmRequest.contents),
      );
    }

    const cacheContentsCount = Math.max(
      previousContentsCount,
      findCountOfContentsToCache(llmRequest.contents),
    );
    const newMetadata = await this.createNewCacheWithContents(
      llmRequest,
      cacheContentsCount,
    );
    if (newMetadata) {
      applyCacheToRequest(
        llmRequest,
        newMetadata.cacheName,
        cacheContentsCount,
      );
      return newMetadata;
    }

    // Creation failed, so keep the largest stable prefix. Shrinking it would
    // make the fingerprint oscillate while the request stays below the size
    // that justifies a cache.
    return this.fingerprintOnlyMetadata(llmRequest, cacheContentsCount);
  }

  /**
   * Deletes a cache.
   *
   * A failure is logged rather than thrown: a stale cache costs storage, but it
   * never breaks a request.
   *
   * @param cacheName The resource name of the cache to delete.
   */
  async cleanupCache(cacheName: string): Promise<void> {
    try {
      await this.genaiClient.caches.delete({name: cacheName});
      logger.debug(`Cache cleaned up: ${cacheName}`);
    } catch (error: unknown) {
      logger.warn(
        `Failed to clean up cache ${cacheName}: ${formatError(error)}`,
      );
    }
  }

  /**
   * Copies the cache metadata onto a response.
   *
   * `invocationsUsed` is left untouched: the request processor owns that
   * increment, and repeating it here would double-count.
   *
   * @param llmResponse The response to populate.
   * @param cacheMetadata The metadata to copy.
   */
  populateCacheMetadataInResponse(
    llmResponse: LlmResponse,
    cacheMetadata: CacheMetadata,
  ): void {
    llmResponse.cacheMetadata = {...cacheMetadata};
  }

  private async fingerprintOnlyMetadata(
    llmRequest: LlmRequest,
    contentsCount: number,
  ): Promise<FingerprintCacheMetadata> {
    return {
      fingerprint: await generateCacheFingerprint(
        llmRequest,
        contentsCount,
        this.cacheScope,
      ),
      contentsCount,
    };
  }

  private async createNewCacheWithContents(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<ActiveCacheMetadata | undefined> {
    const cacheConfig = requireCacheConfig(llmRequest);

    const measuredTokens = llmRequest.cacheableContentsTokenCount;
    if (measuredTokens === undefined) {
      logger.debug(
        'No previous token count available, skipping cache creation for the ' +
          'initial request',
      );
      return undefined;
    }
    if (measuredTokens < cacheConfig.minTokens) {
      logger.debug(
        `Previous request too small for caching (${measuredTokens} < ` +
          `${cacheConfig.minTokens} tokens)`,
      );
      return undefined;
    }

    const prefixTokens = estimateCacheablePrefixTokens(
      llmRequest,
      cacheContentsCount,
    );
    const floor = minimumCacheTokens(llmRequest.model);
    if (floor !== undefined && prefixTokens < floor) {
      logger.debug(
        `Cacheable prefix below the Gemini minimum cache size ` +
          `(${prefixTokens} < ${floor} tokens)`,
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

  private async createGeminiCache(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<ActiveCacheMetadata> {
    const cacheConfig = requireCacheConfig(llmRequest);
    const model = requireModel(llmRequest);

    return tracer.startActiveSpan('create_cache', async (span) => {
      try {
        span.setAttribute('cache_contents_count', cacheContentsCount);
        span.setAttribute('model', model);
        span.setAttribute('ttl_seconds', cacheConfig.ttlSeconds);

        const requestConfig = llmRequest.config;
        const cachePrefix = llmRequest.contents.slice(0, cacheContentsCount);
        const tools = declarativeTools(requestConfig?.tools);
        const createConfig: CreateCachedContentConfig = {
          contents: cachePrefix.length ? cachePrefix : undefined,
          ttl: `${cacheConfig.ttlSeconds}s`,
          displayName: `adk-cache-${Math.floor(nowInSeconds())}-${cacheContentsCount}contents`,
          systemInstruction: requestConfig?.systemInstruction,
          tools: tools.length ? tools : undefined,
          toolConfig: requestConfig?.toolConfig,
          httpOptions: cacheConfig.createHttpOptions,
        };

        const cachedContent = await this.genaiClient.caches.create({
          model,
          config: createConfig,
        });
        const createdAt = nowInSeconds();
        const cacheName = cachedContent.name;
        if (!cacheName) {
          throw new Error('The cache service returned no cache name.');
        }
        logger.debug(`Cache created successfully: ${cacheName}`);
        span.setAttribute('cache_name', cacheName);

        return {
          cacheName,
          expireTime:
            parseExpireTime(cachedContent.expireTime) ??
            createdAt + cacheConfig.ttlSeconds,
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
