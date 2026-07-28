/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';

import {
  Content,
  ContentUnion,
  CreateCachedContentConfig,
  GoogleGenAI,
  Tool,
} from '@google/genai';

import {
  DEFAULT_CONTEXT_CACHE_CONFIG,
  ttlString,
} from '../agents/context_cache_config.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {
  CacheMetadata,
  cacheMetadataToString,
  copyCacheMetadata,
  createCacheMetadata,
} from './cache_metadata.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * Named Gemini model families have documented explicit-cache floors. For opaque
 * tuned-model and endpoint IDs, the server remains authoritative and no
 * client-side minimum is applied.
 */
export const GEMINI_2_5_MIN_CACHE_TOKENS = 2048;
export const GEMINI_3_MIN_CACHE_TOKENS = 4096;

/** Rough estimate of characters per token used for cache-size gating. */
const CHARS_PER_TOKEN = 4;
/** Number of leading hex characters kept from the SHA-256 fingerprint. */
const FINGERPRINT_LENGTH = 16;

/** Backend namespace that owns explicit cache resources. */
interface CacheScope {
  backend: 'vertex' | 'gemini';
  project?: string;
  location?: string;
  baseUrl?: string;
}

/** Defensive view of the SDK's internal API client for scope derivation. */
interface ApiClientInternals {
  getProject?: () => string | undefined;
  getLocation?: () => string | undefined;
  getBaseUrl?: () => string | undefined;
}

/**
 * Manages the context cache lifecycle for Gemini models: fingerprint hashing,
 * cache creation, validation, cleanup, and populating cache metadata onto
 * responses. Content hashing determines cache compatibility so caches are only
 * reused when the cacheable prefix is unchanged.
 */
@experimental
export class GeminiContextCacheManager {
  constructor(private readonly genaiClient: GoogleGenAI) {}

  /**
   * Handles context caching for a Gemini request.
   *
   * Validates existing cache metadata or creates a new cache when appropriate,
   * mutating `llmRequest` in place to reference the cache (setting
   * `config.cachedContent` and stripping the cached prefix from `contents`).
   *
   * @param llmRequest Request that may carry cache config and metadata.
   * @returns The cache metadata to include in the response (active or
   *   fingerprint-only).
   */
  async handleContextCaching(
    llmRequest: LlmRequest,
  ): Promise<CacheMetadata | undefined> {
    if (llmRequest.cacheMetadata) {
      logger.debug(
        `Found existing cache metadata: ${cacheMetadataToString(llmRequest.cacheMetadata)}`,
      );
      if (this.isCacheValid(llmRequest)) {
        logger.debug(
          `Cache is valid, reusing cache: ${llmRequest.cacheMetadata.cacheName}`,
        );
        applyCacheToRequest(
          llmRequest,
          llmRequest.cacheMetadata.cacheName!,
          llmRequest.cacheMetadata.contentsCount,
        );
        return copyCacheMetadata(llmRequest.cacheMetadata);
      }

      const oldCacheMetadata = llmRequest.cacheMetadata;
      if (oldCacheMetadata.cacheName !== undefined) {
        logger.debug(
          `Cache is invalid, cleaning up: ${oldCacheMetadata.cacheName}`,
        );
        await this.cleanupCache(oldCacheMetadata.cacheName);
      }

      const previousCount = oldCacheMetadata.contentsCount;
      const previousFingerprint = this.generateCacheFingerprint(
        llmRequest,
        previousCount,
      );

      if (previousFingerprint === oldCacheMetadata.fingerprint) {
        const currentCacheableCount = findCountOfContentsToCache(
          llmRequest.contents,
        );
        const cacheContentsCount = Math.max(
          previousCount,
          currentCacheableCount,
        );
        const cacheMetadata = await this.createNewCacheWithContents(
          llmRequest,
          cacheContentsCount,
        );
        if (cacheMetadata) {
          applyCacheToRequest(
            llmRequest,
            cacheMetadata.cacheName!,
            cacheContentsCount,
          );
          return cacheMetadata;
        }

        // Cache creation was skipped (for example, below the model minimum).
        // Preserve the largest stable prefix for the next attempt.
        return createCacheMetadata({
          fingerprint: this.generateCacheFingerprint(
            llmRequest,
            cacheContentsCount,
          ),
          contentsCount: cacheContentsCount,
        });
      }

      // Fingerprints differ: request-scoped contents (such as dynamic
      // instructions) must not enter the fingerprint-only chain, so recompute
      // over the current cacheable prefix.
      const cacheContentsCount = findCountOfContentsToCache(
        llmRequest.contents,
      );
      return createCacheMetadata({
        fingerprint: this.generateCacheFingerprint(
          llmRequest,
          cacheContentsCount,
        ),
        contentsCount: cacheContentsCount,
      });
    }

    // No existing metadata: never create a cache on the first request of a
    // session. Return fingerprint-only metadata for later prefix matching.
    const cacheContentsCount = findCountOfContentsToCache(llmRequest.contents);
    return createCacheMetadata({
      fingerprint: this.generateCacheFingerprint(
        llmRequest,
        cacheContentsCount,
      ),
      contentsCount: cacheContentsCount,
    });
  }

  /**
   * Deletes a cache, swallowing (and logging) any error so cleanup never
   * surfaces to the caller.
   */
  async cleanupCache(cacheName: string): Promise<void> {
    try {
      await this.genaiClient.caches.delete({name: cacheName});
      logger.info(`Cache cleaned up: ${cacheName}`);
    } catch (error) {
      logger.warn(`Failed to cleanup cache ${cacheName}: ${error}`);
    }
  }

  /** Copies the given cache metadata onto the response. */
  populateCacheMetadataInResponse(
    llmResponse: LlmResponse,
    cacheMetadata: CacheMetadata,
  ): void {
    llmResponse.cacheMetadata = copyCacheMetadata(cacheMetadata);
  }

  /**
   * Returns whether the cache described by the request metadata is still valid:
   * it must be an active cache (not fingerprint-only), unexpired, within the
   * configured invocation budget, and match the current prefix fingerprint.
   */
  private isCacheValid(llmRequest: LlmRequest): boolean {
    const cacheMetadata = llmRequest.cacheMetadata;
    if (!cacheMetadata || cacheMetadata.cacheName === undefined) {
      return false;
    }

    if (Date.now() / 1000 >= cacheMetadata.expireTime!) {
      logger.info(`Cache expired: ${cacheMetadata.cacheName}`);
      return false;
    }

    const cacheIntervals =
      llmRequest.cacheConfig?.cacheIntervals ??
      DEFAULT_CONTEXT_CACHE_CONFIG.cacheIntervals;
    if (cacheMetadata.invocationsUsed! > cacheIntervals) {
      logger.info(
        `Cache exceeded cache intervals: ${cacheMetadata.cacheName} ` +
          `(${cacheMetadata.invocationsUsed} > ${cacheIntervals} intervals)`,
      );
      return false;
    }

    const currentFingerprint = this.generateCacheFingerprint(
      llmRequest,
      cacheMetadata.contentsCount,
    );
    if (currentFingerprint !== cacheMetadata.fingerprint) {
      logger.debug('Cache content fingerprint mismatch');
      return false;
    }

    return true;
  }

  /**
   * Generates a 16-character fingerprint over the model, backend scope, system
   * instruction, tools, tool config, and the first `cacheContentsCount`
   * contents. Including the model and backend scope keeps caches model- and
   * backend-specific.
   */
  private generateCacheFingerprint(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): string {
    const fingerprintData: Record<string, unknown> = {
      model: llmRequest.model,
      cacheScope: this.cacheScope(),
    };

    const config = llmRequest.config;
    if (config?.systemInstruction) {
      fingerprintData.systemInstruction = config.systemInstruction;
    }
    if (config?.tools) {
      fingerprintData.tools = config.tools;
    }
    if (config?.toolConfig) {
      fingerprintData.toolConfig = config.toolConfig;
    }
    if (cacheContentsCount > 0 && llmRequest.contents.length) {
      fingerprintData.cachedContents = llmRequest.contents.slice(
        0,
        cacheContentsCount,
      );
    }

    const canonical = canonicalJson(fingerprintData);
    return createHash('sha256')
      .update(canonical)
      .digest('hex')
      .slice(0, FINGERPRINT_LENGTH);
  }

  /**
   * Creates a new cache when the gates pass: a previous prompt token count must
   * exist, meet the configured `minTokens`, and the estimated cacheable prefix
   * must reach the model-specific minimum. Returns undefined (skip caching) when
   * any gate fails or creation errors.
   */
  private async createNewCacheWithContents(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<CacheMetadata | undefined> {
    if (llmRequest.cacheableContentsTokenCount === undefined) {
      logger.info(
        'No previous token count available, skipping cache creation for ' +
          'initial request',
      );
      return undefined;
    }

    const minTokens =
      llmRequest.cacheConfig?.minTokens ??
      DEFAULT_CONTEXT_CACHE_CONFIG.minTokens;
    if (llmRequest.cacheableContentsTokenCount < minTokens) {
      logger.info(
        `Previous request too small for caching ` +
          `(${llmRequest.cacheableContentsTokenCount} < ${minTokens} tokens)`,
      );
      return undefined;
    }

    // Gate on the estimated size of the cached prefix, not the full previous
    // prompt: on a long conversation the full count can clear the floor while
    // the prefix is far smaller, which would make cache creation fail.
    const cacheablePrefixTokens = estimateCacheablePrefixTokens(
      llmRequest,
      cacheContentsCount,
    );
    const minCacheTokens = minimumCacheTokens(llmRequest.model);
    if (
      minCacheTokens !== undefined &&
      cacheablePrefixTokens < minCacheTokens
    ) {
      logger.info(
        `Cacheable prefix below Gemini minimum cache size ` +
          `(${cacheablePrefixTokens} < ${minCacheTokens} tokens)`,
      );
      return undefined;
    }

    try {
      return await this.createGeminiCache(llmRequest, cacheContentsCount);
    } catch (error) {
      logger.warn(`Failed to create cache: ${error}`);
      return undefined;
    }
  }

  /** Creates the cache via the GenAI client and returns active metadata. */
  private async createGeminiCache(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<CacheMetadata> {
    const config = llmRequest.config;
    const cacheConfig = llmRequest.cacheConfig;
    const cachedContents = llmRequest.contents.slice(0, cacheContentsCount);

    const createConfig: CreateCachedContentConfig = {
      contents: cachedContents.length ? cachedContents : undefined,
      ttl: ttlString(cacheConfig ?? DEFAULT_CONTEXT_CACHE_CONFIG),
      displayName: `adk-cache-${Math.floor(Date.now() / 1000)}-${cacheContentsCount}contents`,
    };
    if (config?.systemInstruction) {
      createConfig.systemInstruction = config.systemInstruction;
    }
    if (config?.tools) {
      // Request configs use the broader ToolListUnion; the cacheable prefix only
      // ever carries plain Tool declarations, matching CreateCachedContentConfig.
      createConfig.tools = config.tools as Tool[];
    }
    if (config?.toolConfig) {
      createConfig.toolConfig = config.toolConfig;
    }
    if (cacheConfig?.createHttpOptions) {
      createConfig.httpOptions = cacheConfig.createHttpOptions;
    }

    const cachedContent = await this.genaiClient.caches.create({
      model: llmRequest.model!,
      config: createConfig,
    });
    const createdAt = Date.now() / 1000;
    const ttlSeconds =
      cacheConfig?.ttlSeconds ?? DEFAULT_CONTEXT_CACHE_CONFIG.ttlSeconds;
    logger.info(`Cache created successfully: ${cachedContent.name}`);

    return createCacheMetadata({
      cacheName: cachedContent.name,
      expireTime: computeExpireTime(
        cachedContent.expireTime,
        createdAt,
        ttlSeconds,
      ),
      fingerprint: this.generateCacheFingerprint(
        llmRequest,
        cacheContentsCount,
      ),
      invocationsUsed: 1,
      contentsCount: cacheContentsCount,
      createdAt,
    });
  }

  /** Returns the backend namespace that owns explicit cache resources. */
  private cacheScope(): CacheScope {
    const isVertex = Boolean(this.genaiClient.vertexai);
    const scope: CacheScope = {backend: isVertex ? 'vertex' : 'gemini'};

    const apiClient = (
      this.genaiClient as unknown as {apiClient?: ApiClientInternals}
    ).apiClient;
    if (isVertex && apiClient) {
      scope.project = apiClient.getProject?.();
      scope.location = apiClient.getLocation?.();
    }
    const baseUrl = apiClient?.getBaseUrl?.();
    if (baseUrl) {
      scope.baseUrl = baseUrl;
    }
    return scope;
  }
}

/**
 * Returns the explicit-cache token floor for a named Gemini model, or undefined
 * for opaque model IDs where the server remains authoritative.
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
 * Returns the number of leading contents to cache: everything before the last
 * contiguous run of `user`-role contents (which is always sent to the model).
 */
export function findCountOfContentsToCache(contents: Content[]): number {
  if (!contents.length) {
    return 0;
  }
  let lastUserBatchStart = contents.length;
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i].role === 'user') {
      lastUserBatchStart = i;
    } else {
      break;
    }
  }
  return lastUserBatchStart;
}

/**
 * Roughly estimates the token count of the request (or its cacheable prefix
 * when `cacheContentsCount` is provided) from the character length of the system
 * instruction, tools, and content text.
 */
export function estimateRequestTokens(
  llmRequest: LlmRequest,
  cacheContentsCount?: number,
): number {
  let totalChars = 0;

  const config = llmRequest.config;
  if (config?.systemInstruction) {
    totalChars += instructionLength(config.systemInstruction);
  }
  if (config?.tools) {
    for (const tool of config.tools) {
      totalChars += JSON.stringify(tool).length;
    }
  }

  const contents =
    cacheContentsCount === undefined
      ? llmRequest.contents
      : llmRequest.contents.slice(0, cacheContentsCount);
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.text) {
        totalChars += part.text.length;
      }
    }
  }

  return Math.floor(totalChars / CHARS_PER_TOKEN);
}

/**
 * Estimates the token count of the prefix that will actually be cached by
 * scaling the accurate full previous-prompt count by the prefix's estimated
 * share of the request.
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
    // No text to estimate from; fall back to the accurate full count rather
    // than incorrectly skipping the cache.
    return fullTokens;
  }

  const prefixEstimate = estimateRequestTokens(llmRequest, cacheContentsCount);
  const ratio = Math.min(1, prefixEstimate / fullEstimate);
  return Math.floor(fullTokens * ratio);
}

/**
 * Applies a cache to the request in place: removes the cached fields from the
 * config, references the cache via `cachedContent`, and strips the cached prefix
 * from `contents`.
 */
export function applyCacheToRequest(
  llmRequest: LlmRequest,
  cacheName: string,
  cacheContentsCount: number,
): void {
  llmRequest.config ??= {};
  llmRequest.config.systemInstruction = undefined;
  llmRequest.config.tools = undefined;
  llmRequest.config.toolConfig = undefined;
  llmRequest.config.cachedContent = cacheName;
  llmRequest.contents = llmRequest.contents.slice(cacheContentsCount);
}

/**
 * Derives the cache expiry (Unix seconds) from the server-reported expiry when
 * available, otherwise from the creation time plus the configured TTL.
 */
function computeExpireTime(
  serverExpireTime: string | undefined,
  createdAt: number,
  ttlSeconds: number,
): number {
  if (serverExpireTime) {
    const parsed = Date.parse(serverExpireTime) / 1000;
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return createdAt + ttlSeconds;
}

/** Returns the character length of a system instruction of any supported form. */
function instructionLength(instruction: ContentUnion): number {
  return typeof instruction === 'string'
    ? instruction.length
    : JSON.stringify(instruction).length;
}

/**
 * Serializes a value to deterministic JSON with recursively sorted object keys
 * and compact separators, so semantically identical values hash identically
 * regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** Recursively returns a copy of `value` with all object keys sorted. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}
