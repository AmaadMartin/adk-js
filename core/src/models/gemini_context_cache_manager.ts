/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  ContentUnion,
  CreateCachedContentConfig,
  GoogleGenAI,
  Tool,
  ToolUnion,
} from '@google/genai';

import {ContextCacheConfig} from '../agents/context_cache_config.js';
import {tracer} from '../telemetry/tracing.js';
import {canonicalJson, stableDigest} from '../utils/digest_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {
  ActiveCacheMetadata,
  CacheMetadata,
  FingerprintCacheMetadata,
} from './cache_metadata.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * Explicit-cache token floor for the `gemini-2.5-*` family.
 *
 * The server rejects a smaller cache, so the manager skips creating one.
 */
const GEMINI_2_5_MIN_CACHE_TOKENS = 2048;

/** Explicit-cache token floor for the `gemini-3*` family. */
const GEMINI_3_MIN_CACHE_TOKENS = 4096;

/** Characters per token in the rough size estimate. */
const CHARACTERS_PER_TOKEN = 4;

/**
 * The part of the GenAI client that the cache manager uses.
 *
 * A `GoogleGenAI` satisfies it, and so does a test double, which keeps the
 * manager free of a cast to the full client type.
 */
export interface CacheClient {
  readonly caches: Pick<GoogleGenAI['caches'], 'create' | 'delete'>;
}

/**
 * The backend namespace that owns explicit cache resources.
 *
 * A cache created against one backend, project or location cannot be read from
 * another, so the scope is part of the cache fingerprint.
 */
export interface CacheScope {
  /** Which Gemini backend serves the request. */
  backend: 'vertex' | 'gemini';

  /** The Vertex AI project. Set only when `backend` is `vertex`. */
  project?: string;

  /** The Vertex AI location. Set only when `backend` is `vertex`. */
  location?: string;
}

/**
 * Returns the explicit-cache token floor for a named Gemini model.
 *
 * An opaque tuned-model or endpoint ID has no client-side floor, because the
 * server remains authoritative for it.
 *
 * @param model The model name, which may be a full resource path.
 * @returns The floor in tokens, or `undefined` when the model has none.
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
 * Returns how many leading contents are eligible for caching.
 *
 * The last continuous batch of user contents is the live turn, so everything
 * before it is stable enough to cache. There is no such batch when the last
 * content is not a user content, and then every content is eligible.
 *
 * @param contents The request contents.
 * @returns The number of leading contents to cache, possibly zero.
 */
export function findCountOfContentsToCache(contents: Content[]): number {
  let lastUserBatchStart = contents.length;
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i].role !== 'user') {
      break;
    }
    lastUserBatchStart = i;
  }
  return lastUserBatchStart;
}

/**
 * Returns a stable rough size for a system-instruction value.
 *
 * @param value The system instruction, which may be text or structured parts.
 * @returns The character count.
 */
export function contentUnionCharacterCount(value: ContentUnion): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, item) =>
        total +
        (typeof item === 'string' ? item.length : canonicalJson(item).length),
      0,
    );
  }
  return canonicalJson(value).length;
}

/**
 * Estimates the token count of a request, or of its cacheable prefix.
 *
 * The estimate is a character count divided by
 * {@link CHARACTERS_PER_TOKEN}. It is only ever used as a ratio against
 * another estimate, so its absolute accuracy does not matter.
 *
 * @param llmRequest The request to measure.
 * @param cacheContentsCount When given, only the first `cacheContentsCount`
 *     contents are counted. The system instruction and the tools always count.
 * @returns The estimated token count.
 */
export function estimateRequestTokens(
  llmRequest: LlmRequest,
  cacheContentsCount?: number,
): number {
  const config = llmRequest.config;
  let totalChars = 0;
  if (config?.systemInstruction) {
    totalChars += contentUnionCharacterCount(config.systemInstruction);
  }
  for (const tool of config?.tools ?? []) {
    if (isTool(tool)) {
      totalChars += canonicalJson(tool).length;
    }
  }
  const contents =
    cacheContentsCount === undefined
      ? llmRequest.contents
      : llmRequest.contents.slice(0, cacheContentsCount);
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      totalChars += part.text?.length ?? 0;
    }
  }
  return Math.floor(totalChars / CHARACTERS_PER_TOKEN);
}

/**
 * Estimates the token count of the prefix that a cache would actually hold.
 *
 * `cacheableContentsTokenCount` is the only accurate count available, and it
 * covers the whole previous prompt. The cache holds just the leading contents
 * plus the system instruction and the tools, so the accurate count is scaled
 * by the prefix's estimated share of the request.
 *
 * @param llmRequest The request to measure.
 * @param cacheContentsCount The number of leading contents the cache holds.
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
    // Nothing to estimate from, for example a prompt of non-text parts. The
    // accurate full count is a better answer than skipping the cache.
    return fullTokens;
  }
  const prefixEstimate = estimateRequestTokens(llmRequest, cacheContentsCount);
  const ratio = Math.min(1, prefixEstimate / fullEstimate);
  return Math.floor(fullTokens * ratio);
}

/**
 * Rewrites a request to read its prefix from a cache.
 *
 * The system instruction, the tools and the tool config live in the cache, so
 * they are removed from the request. The API rejects a request with no
 * contents, so the final content is always sent, even when the cache already
 * covers it.
 *
 * @param llmRequest The request to rewrite in place.
 * @param cacheName The full resource name of the cache.
 * @param cacheContentsCount The number of leading contents the cache holds.
 */
export function applyCacheToRequest(
  llmRequest: LlmRequest,
  cacheName: string,
  cacheContentsCount: number,
): void {
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
 * Computes the identity of the cacheable part of a request.
 *
 * Two requests share a cache only when their fingerprints match, so the
 * fingerprint covers everything the cache holds: the model, the backend scope,
 * the system instruction, the tools, the tool config and the cached content
 * prefix.
 *
 * @param llmRequest The request to fingerprint.
 * @param cacheContentsCount The number of leading contents the cache holds.
 * @param scope The backend namespace that owns the cache.
 * @returns A short hexadecimal fingerprint.
 */
export async function generateCacheFingerprint(
  llmRequest: LlmRequest,
  cacheContentsCount: number,
  scope: CacheScope,
): Promise<string> {
  const config = llmRequest.config;
  const fingerprintData: Record<string, unknown> = {
    model: llmRequest.model,
    cacheScope: scope,
  };
  if (config?.systemInstruction) {
    fingerprintData['systemInstruction'] = config.systemInstruction;
  }
  if (config?.tools?.length) {
    fingerprintData['tools'] = canonicalizeTools(config.tools);
  }
  if (config?.toolConfig) {
    fingerprintData['toolConfig'] = config.toolConfig;
  }
  if (cacheContentsCount > 0 && llmRequest.contents.length > 0) {
    fingerprintData['cachedContents'] = llmRequest.contents.slice(
      0,
      cacheContentsCount,
    );
  }
  return stableDigest(fingerprintData);
}

/**
 * Reports whether an active cache can still serve a request.
 *
 * @param llmRequest The request the cache would serve.
 * @param metadata The metadata of the cache to check.
 * @param cacheConfig The caching configuration of the request.
 * @param scope The backend namespace that owns the cache.
 * @returns True when the cache is live, within its use budget and still
 *     matches the request.
 */
export async function isCacheValid(
  llmRequest: LlmRequest,
  metadata: ActiveCacheMetadata,
  cacheConfig: ContextCacheConfig,
  scope: CacheScope,
): Promise<boolean> {
  if (Date.now() / 1000 >= metadata.expireTime) {
    logger.debug(`Context cache expired: ${metadata.cacheName}`);
    return false;
  }
  if (metadata.invocationsUsed > cacheConfig.cacheIntervals) {
    logger.debug(
      `Context cache exceeded its interval budget: ${metadata.cacheName} ` +
        `(${metadata.invocationsUsed} > ${cacheConfig.cacheIntervals})`,
    );
    return false;
  }
  const fingerprint = await generateCacheFingerprint(
    llmRequest,
    metadata.contentsCount,
    scope,
  );
  if (fingerprint !== metadata.fingerprint) {
    logger.debug('Context cache fingerprint mismatch.');
    return false;
  }
  return true;
}

/**
 * Copies cache metadata onto a response.
 *
 * The use count is not advanced here. Advancing it is the caller's job.
 *
 * @param llmResponse The response to annotate.
 * @param cacheMetadata The metadata of the cache that served the response.
 */
export function populateCacheMetadataInResponse(
  llmResponse: LlmResponse,
  cacheMetadata: CacheMetadata,
): void {
  llmResponse.cacheMetadata = {...cacheMetadata};
}

/**
 * Manages the explicit context cache lifecycle for Gemini models.
 *
 * The manager fingerprints the cacheable part of a request, decides whether an
 * existing cache still serves it, creates a replacement when it does not, and
 * rewrites the request to read from the cache it settled on. It owns the
 * `CachedContent` resources it creates, so it is a class rather than a set of
 * functions.
 */
@experimental
export class GeminiContextCacheManager {
  /**
   * @param genaiClient The client that owns the cache resources.
   * @param scope The backend namespace those resources live in.
   */
  constructor(
    private readonly genaiClient: CacheClient,
    private readonly scope: CacheScope,
  ) {}

  /**
   * Settles the context cache for one request.
   *
   * The request is rewritten in place when a cache serves it. Otherwise it is
   * left alone and the returned metadata records the prefix that a later turn
   * can cache.
   *
   * @param llmRequest The request to cache, modified in place.
   * @returns The metadata to carry into the response.
   * @throws Error If the request has no cache configuration or no model.
   */
  async handleContextCaching(llmRequest: LlmRequest): Promise<CacheMetadata> {
    const model = llmRequest.model;
    if (!model) {
      throw new Error('Context caching requires a model name.');
    }
    const cacheConfig = llmRequest.cacheConfig;
    if (!cacheConfig) {
      throw new Error('Context caching requires a cache configuration.');
    }

    const previous = llmRequest.cacheMetadata;
    if (!previous) {
      return this.fingerprintOnly(
        llmRequest,
        findCountOfContentsToCache(llmRequest.contents),
      );
    }

    if (previous.cacheName !== undefined) {
      if (await isCacheValid(llmRequest, previous, cacheConfig, this.scope)) {
        applyCacheToRequest(
          llmRequest,
          previous.cacheName,
          previous.contentsCount,
        );
        return {...previous};
      }
      await this.cleanupCache(previous.cacheName);
    }

    const previousFingerprint = await generateCacheFingerprint(
      llmRequest,
      previous.contentsCount,
      this.scope,
    );
    if (previousFingerprint !== previous.fingerprint) {
      // The cacheable prefix itself changed, so the previous count describes
      // content that is no longer there. Start the chain again.
      return this.fingerprintOnly(
        llmRequest,
        findCountOfContentsToCache(llmRequest.contents),
      );
    }

    const cacheContentsCount = Math.max(
      previous.contentsCount,
      findCountOfContentsToCache(llmRequest.contents),
    );
    const created = await this.createNewCacheWithContents(
      llmRequest,
      cacheContentsCount,
      cacheConfig,
      model,
    );
    if (!created) {
      // Keep the grown prefix so the next turn can try to cache it again.
      return this.fingerprintOnly(llmRequest, cacheContentsCount);
    }
    applyCacheToRequest(llmRequest, created.cacheName, cacheContentsCount);
    return created;
  }

  /**
   * Deletes a cache.
   *
   * A failed deletion is logged and swallowed, because it must not fail the
   * user's request.
   *
   * @param cacheName The full resource name of the cache.
   */
  async cleanupCache(cacheName: string): Promise<void> {
    try {
      await this.genaiClient.caches.delete({name: cacheName});
      logger.debug(`Context cache deleted: ${cacheName}`);
    } catch (e: unknown) {
      logger.warn(`Failed to delete the context cache ${cacheName}:`, e);
    }
  }

  private async fingerprintOnly(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<FingerprintCacheMetadata> {
    return {
      fingerprint: await generateCacheFingerprint(
        llmRequest,
        cacheContentsCount,
        this.scope,
      ),
      contentsCount: cacheContentsCount,
    };
  }

  /**
   * Creates a cache when the request clears every size gate.
   *
   * @returns The new cache's metadata, or `undefined` when the request is too
   *     small to cache or the service rejected it.
   */
  private async createNewCacheWithContents(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
    cacheConfig: ContextCacheConfig,
    model: string,
  ): Promise<ActiveCacheMetadata | undefined> {
    const previousPromptTokens = llmRequest.cacheableContentsTokenCount;
    if (previousPromptTokens === undefined) {
      logger.debug(
        'No previous token count available, skipping context cache creation.',
      );
      return undefined;
    }
    if (previousPromptTokens < cacheConfig.minTokens) {
      logger.debug(
        `Previous request too small to cache (${previousPromptTokens} < ` +
          `${cacheConfig.minTokens} tokens).`,
      );
      return undefined;
    }
    // The accurate token count covers the whole previous prompt, while the
    // cache only holds the prefix. Gate on the prefix, or a long conversation
    // sends a sub-minimum payload and the service rejects it.
    const floor = minimumCacheTokens(model);
    const prefixTokens = estimateCacheablePrefixTokens(
      llmRequest,
      cacheContentsCount,
    );
    if (floor !== undefined && prefixTokens < floor) {
      logger.debug(
        `Cacheable prefix below the model's minimum cache size ` +
          `(${prefixTokens} < ${floor} tokens).`,
      );
      return undefined;
    }
    try {
      return await this.createGeminiCache(
        llmRequest,
        cacheContentsCount,
        cacheConfig,
        model,
      );
    } catch (e: unknown) {
      logger.warn('Failed to create the context cache:', e);
      return undefined;
    }
  }

  private async createGeminiCache(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
    cacheConfig: ContextCacheConfig,
    model: string,
  ): Promise<ActiveCacheMetadata> {
    return tracer.startActiveSpan('create_cache', async (span) => {
      try {
        span.setAttribute('cache_contents_count', cacheContentsCount);
        span.setAttribute('model', model);
        span.setAttribute('ttl_seconds', cacheConfig.ttlSeconds);

        const cachedContent = await this.genaiClient.caches.create({
          model,
          config: buildCreateCacheConfig(
            llmRequest,
            cacheContentsCount,
            cacheConfig,
          ),
        });
        const createdAt = Date.now() / 1000;
        const cacheName = cachedContent.name;
        if (!cacheName) {
          throw new Error('The cache service returned no cache name.');
        }
        span.setAttribute('cache_name', cacheName);
        logger.debug(`Context cache created: ${cacheName}`);

        return {
          cacheName,
          expireTime:
            parseExpireTime(cachedContent.expireTime) ??
            createdAt + cacheConfig.ttlSeconds,
          fingerprint: await generateCacheFingerprint(
            llmRequest,
            cacheContentsCount,
            this.scope,
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

/**
 * Narrows a tool to a declarative {@link Tool}.
 *
 * A `CallableTool` carries executable behaviour rather than a declaration, so
 * it cannot be cached or fingerprinted.
 */
function isTool(tool: ToolUnion): tool is Tool {
  return !('tool' in tool);
}

function buildCreateCacheConfig(
  llmRequest: LlmRequest,
  cacheContentsCount: number,
  cacheConfig: ContextCacheConfig,
): CreateCachedContentConfig {
  const requestConfig = llmRequest.config;
  const config: CreateCachedContentConfig = {
    ttl: `${cacheConfig.ttlSeconds}s`,
    displayName: `adk-cache-${Math.floor(Date.now() / 1000)}-${cacheContentsCount}contents`,
  };
  const prefix = llmRequest.contents.slice(0, cacheContentsCount);
  if (prefix.length > 0) {
    config.contents = prefix;
  }
  if (requestConfig?.systemInstruction) {
    config.systemInstruction = requestConfig.systemInstruction;
  }
  if (requestConfig?.tools?.length) {
    config.tools = requestConfig.tools.filter(isTool);
  }
  if (requestConfig?.toolConfig) {
    config.toolConfig = requestConfig.toolConfig;
  }
  if (cacheConfig.createHttpOptions) {
    config.httpOptions = cacheConfig.createHttpOptions;
  }
  return config;
}

/** Converts the service's RFC 3339 expiry into a Unix timestamp in seconds. */
function parseExpireTime(expireTime?: string): number | undefined {
  if (!expireTime) {
    return undefined;
  }
  const parsed = Date.parse(expireTime);
  return Number.isNaN(parsed) ? undefined : parsed / 1000;
}

/**
 * Orders the tools so that a reordered tool list produces the same
 * fingerprint.
 */
function canonicalizeTools(tools: ToolUnion[]): string[] {
  return tools.filter(isTool).map(canonicalizeTool).sort();
}

/**
 * Serializes a tool so that reordering its function declarations does not
 * change the text. Only {@link generateCacheFingerprint} reads the result, so
 * the text carries everything the fingerprint needs.
 */
function canonicalizeTool(tool: Tool): string {
  if (!tool.functionDeclarations) {
    return canonicalJson(tool);
  }
  return canonicalJson({
    ...tool,
    functionDeclarations: tool.functionDeclarations.map(canonicalJson).sort(),
  });
}
