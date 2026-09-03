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

import {ContextCacheConfig, ttlString} from '../agents/context_cache_config.js';
import {tracer} from '../telemetry/tracing.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {ActiveCacheMetadata, CacheMetadata} from './cache_metadata.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * Named Gemini model families have documented explicit-cache floors. For
 * opaque tuned-model and endpoint IDs, the server remains authoritative.
 */
const GEMINI_2_5_MIN_CACHE_TOKENS = 2048;
const GEMINI_3_MIN_CACHE_TOKENS = 4096;

/** The rough character-to-token ratio the size estimate assumes. */
const CHARACTERS_PER_TOKEN = 4;

/** The number of hexadecimal characters kept from the fingerprint digest. */
const FINGERPRINT_LENGTH = 16;

/** The backend namespace that owns an explicit cache resource. */
export interface CacheScope {
  /** The backend the cache lives on. */
  backend: 'vertex' | 'gemini';
  /** The Vertex AI project, on the Vertex backend only. */
  project?: string;
  /** The Vertex AI location, on the Vertex backend only. */
  location?: string;
  /** The API endpoint the client talks to. */
  base_url?: string;
}

/**
 * The internals of the SDK client that identify the backend namespace.
 *
 * `GoogleGenAI` keeps its API client protected and exposes no accessor for the
 * project, the location or the endpoint, so the scope is read reflectively and
 * narrowed here. A client that does not answer this shape yields a scope
 * carrying the backend alone.
 */
interface ScopeAccessors {
  getProject(): string | undefined;
  getLocation(): string | undefined;
  getBaseUrl(): string | undefined;
}

function hasFunction(value: object, name: string): boolean {
  return name in value && typeof Reflect.get(value, name) === 'function';
}

function isScopeAccessors(value: unknown): value is ScopeAccessors {
  return (
    typeof value === 'object' &&
    value !== null &&
    hasFunction(value, 'getProject') &&
    hasFunction(value, 'getLocation') &&
    hasFunction(value, 'getBaseUrl')
  );
}

/**
 * Returns the backend namespace that owns explicit cache resources.
 *
 * A cache created against one backend, project, location or endpoint must
 * never be reused against another, so all four are part of the cache identity.
 *
 * @param client The SDK client the cache is created through.
 * @returns The scope to fold into the fingerprint.
 */
export function cacheScope(client: GoogleGenAI): CacheScope {
  const isVertex = !!client.vertexai;
  const scope: CacheScope = {backend: isVertex ? 'vertex' : 'gemini'};

  const apiClient: unknown = Reflect.get(client, 'apiClient');
  if (!isScopeAccessors(apiClient)) {
    return scope;
  }

  if (isVertex) {
    scope.project = apiClient.getProject();
    scope.location = apiClient.getLocation();
  }
  const baseUrl = apiClient.getBaseUrl();
  if (baseUrl) {
    scope.base_url = baseUrl;
  }
  return scope;
}

/**
 * Returns the explicit-cache token floor for a named Gemini model.
 *
 * @param model The model name, which may be a full resource path.
 * @returns The floor, or `undefined` when the model name is opaque and the
 *     server is the only authority on the minimum.
 */
export function minimumCacheTokens(model = ''): number | undefined {
  const modelName = model.slice(model.lastIndexOf('/') + 1);
  if (modelName.startsWith('gemini-2.5-')) {
    return GEMINI_2_5_MIN_CACHE_TOKENS;
  }
  if (modelName.startsWith('gemini-3')) {
    return GEMINI_3_MIN_CACHE_TOKENS;
  }
  return undefined;
}

/** Narrows metadata to the state that names a live cache. */
function asActiveMetadata(
  metadata: CacheMetadata,
): ActiveCacheMetadata | undefined {
  return metadata.cacheName === undefined ? undefined : metadata;
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

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep(Reflect.get(value, key));
  }
  return sorted;
}

/**
 * Serialises a value so that two semantically identical values produce the
 * same string, whatever order their keys were inserted in.
 *
 * @param value The value to serialise.
 * @returns The canonical JSON form, with sorted keys and no whitespace.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? '';
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
        (typeof item === 'string' ? item.length : canonicalJson(item).length),
      0,
    );
  }
  return canonicalJson(value).length;
}

/** A tool the model declares, as opposed to one the SDK calls on its behalf. */
function isDeclarativeTool(tool: ToolUnion): tool is Tool {
  return !('tool' in tool);
}

function declarativeTools(llmRequest: LlmRequest): Tool[] {
  return (llmRequest.config?.tools ?? []).filter(isDeclarativeTool);
}

/**
 * Orders a tool's function declarations by name, so that a reordered
 * declaration list keeps the same cache identity.
 */
function canonicalTool(tool: Tool): Tool {
  if (!tool.functionDeclarations) {
    return tool;
  }
  return {
    ...tool,
    functionDeclarations: [...tool.functionDeclarations].sort((left, right) =>
      (left.name ?? '').localeCompare(right.name ?? ''),
    ),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * Generates the fingerprint that decides whether a cache still matches the
 * request.
 *
 * It covers the model, the backend scope, the system instruction, the tools,
 * the tool config and the leading contents that the cache holds. The keys
 * follow the reference implementation in `adk-python` rather than the local
 * naming convention, so the two stay readable side by side.
 *
 * @param llmRequest The request to fingerprint.
 * @param cacheContentsCount The number of leading contents the cache covers.
 * @param scope The backend namespace that owns the cache.
 * @returns The first 16 hexadecimal characters of the SHA-256 digest.
 */
export async function generateCacheFingerprint(
  llmRequest: LlmRequest,
  cacheContentsCount: number,
  scope: CacheScope,
): Promise<string> {
  const fingerprintData: Record<string, unknown> = {
    model: llmRequest.model,
    cache_scope: scope,
  };

  const config = llmRequest.config;
  if (config?.systemInstruction) {
    fingerprintData['system_instruction'] = config.systemInstruction;
  }

  const tools = declarativeTools(llmRequest);
  if (config?.tools?.length) {
    fingerprintData['tools'] = tools
      .map(canonicalTool)
      .sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      );
  }

  if (config?.toolConfig) {
    fingerprintData['tool_config'] = config.toolConfig;
  }

  if (cacheContentsCount > 0 && llmRequest.contents.length) {
    fingerprintData['cached_contents'] = llmRequest.contents.slice(
      0,
      cacheContentsCount,
    );
  }

  const digest = await sha256Hex(canonicalJson(fingerprintData));
  return digest.slice(0, FINGERPRINT_LENGTH);
}

/**
 * Finds how many leading contents a cache may cover.
 *
 * The last continuous run of user contents belongs to the current turn, so
 * everything before it is cacheable. When the last content is not a user
 * content there is no such run, and every content is cacheable.
 *
 * @param contents The request's contents.
 * @returns The number of leading contents to cache.
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
 * Estimates the token count of a request, or of its cacheable prefix.
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
  let totalCharacters = 0;

  const config = llmRequest.config;
  if (config?.systemInstruction) {
    totalCharacters += contentUnionCharacterCount(config.systemInstruction);
  }

  for (const tool of declarativeTools(llmRequest)) {
    totalCharacters += canonicalJson(tool).length;
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
 * Estimates the token count of the prefix that the cache actually holds.
 *
 * `cacheableContentsTokenCount` is the only accurate figure available, and it
 * covers the whole previous prompt. The cache holds just the leading contents
 * plus the system instruction and the tools, so the accurate count is scaled
 * by the prefix's estimated share of the request.
 *
 * @param llmRequest The request to measure.
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
    // Nothing textual to scale by, for example a prompt of inline data only.
    return fullTokens;
  }

  const prefixEstimate = estimateRequestTokens(llmRequest, cacheContentsCount);
  return Math.floor(fullTokens * Math.min(1, prefixEstimate / fullEstimate));
}

/**
 * Rewrites the request to read its prefix from the cache.
 *
 * @param llmRequest The request to rewrite, modified in place.
 * @param cacheName The full resource name of the cache.
 * @param cacheContentsCount The number of leading contents the cache holds.
 */
export function applyCacheToRequest(
  llmRequest: LlmRequest,
  cacheName: string,
  cacheContentsCount: number,
): void {
  const config = llmRequest.config ?? {};
  config.systemInstruction = undefined;
  config.tools = undefined;
  config.toolConfig = undefined;
  config.cachedContent = cacheName;
  llmRequest.config = config;

  // The API rejects a request with no contents, so the final content is always
  // sent, even when the cache already holds it.
  const removableCount = Math.min(
    cacheContentsCount,
    Math.max(llmRequest.contents.length - 1, 0),
  );
  llmRequest.contents = llmRequest.contents.slice(removableCount);
}

/**
 * Manages the context cache lifecycle for Gemini models.
 *
 * The manager creates, validates, reuses and deletes an explicit Gemini cache,
 * and reports the cache identity that served a response. It decides cache
 * compatibility by fingerprinting the cacheable part of the request.
 *
 * WARNING: This feature is **experimental** and its API or behavior may
 * change in future releases.
 */
@experimental
export class GeminiContextCacheManager {
  private readonly scope: CacheScope;

  /**
   * @param genaiClient The SDK client to run cache operations through.
   */
  constructor(private readonly genaiClient: GoogleGenAI) {
    this.scope = cacheScope(genaiClient);
  }

  /**
   * Applies context caching to a Gemini request.
   *
   * It reuses a valid cache, replaces an invalidated one, and otherwise
   * fingerprints the cacheable prefix so that a later turn can cache it. The
   * request is modified in place when a cache applies.
   *
   * @param llmRequest The request to cache, modified in place.
   * @returns The metadata to report on the response.
   * @throws Error if the request carries no model or no cache configuration.
   */
  async handleContextCaching(
    llmRequest: LlmRequest,
  ): Promise<CacheMetadata | undefined> {
    requireModel(llmRequest);
    requireCacheConfig(llmRequest);

    const oldCacheMetadata = llmRequest.cacheMetadata;
    if (!oldCacheMetadata) {
      logger.debug('No existing cache metadata, creating fingerprint-only one');
      return this.fingerprintOnlyMetadata(llmRequest);
    }

    const active = asActiveMetadata(oldCacheMetadata);
    if (active && (await this.isCacheValid(llmRequest, active))) {
      logger.debug(`Cache is valid, reusing cache: ${active.cacheName}`);
      applyCacheToRequest(llmRequest, active.cacheName, active.contentsCount);
      return {...active};
    }

    if (active) {
      logger.debug(`Cache is invalid, cleaning up: ${active.cacheName}`);
      await this.cleanupCache(active.cacheName);
    }

    const previousContentsCount = oldCacheMetadata.contentsCount;
    const previousFingerprint = await generateCacheFingerprint(
      llmRequest,
      previousContentsCount,
      this.scope,
    );
    if (previousFingerprint !== oldCacheMetadata.fingerprint) {
      logger.debug("Fingerprints don't match, returning fingerprint-only one");
      return this.fingerprintOnlyMetadata(llmRequest);
    }

    logger.debug('Fingerprints match after invalidation, creating new cache');
    const contentsCount = Math.max(
      previousContentsCount,
      findCountOfContentsToCache(llmRequest.contents),
    );
    const cacheMetadata = await this.createNewCacheWithContents(
      llmRequest,
      contentsCount,
    );
    if (cacheMetadata) {
      applyCacheToRequest(llmRequest, cacheMetadata.cacheName, contentsCount);
      return cacheMetadata;
    }

    // Cache creation failed, for example below the model's minimum. Keep the
    // largest stable prefix so the next attempt does not start over.
    logger.debug(
      `Cache creation failed, preserving prefix fingerprint ` +
        `(contentsCount=${contentsCount})`,
    );
    return {
      fingerprint: await generateCacheFingerprint(
        llmRequest,
        contentsCount,
        this.scope,
      ),
      contentsCount,
    };
  }

  /**
   * Deletes a cache.
   *
   * A cache that cannot be deleted must not fail the turn, so a failure is
   * logged and swallowed.
   *
   * @param cacheName The full resource name of the cache to delete.
   */
  async cleanupCache(cacheName: string): Promise<void> {
    logger.debug(`Attempting to delete cache: ${cacheName}`);
    try {
      await this.genaiClient.caches.delete({name: cacheName});
      logger.info(`Cache cleaned up: ${cacheName}`);
    } catch (e: unknown) {
      logger.warn(`Failed to cleanup cache ${cacheName}: ${e}`);
    }
  }

  /**
   * Records on a response the cache that served it.
   *
   * @param llmResponse The response to record the metadata on.
   * @param cacheMetadata The metadata to copy onto the response.
   */
  populateCacheMetadataInResponse(
    llmResponse: LlmResponse,
    cacheMetadata: CacheMetadata,
  ): void {
    llmResponse.cacheMetadata = {...cacheMetadata};
  }

  private async fingerprintOnlyMetadata(
    llmRequest: LlmRequest,
  ): Promise<CacheMetadata> {
    const contentsCount = findCountOfContentsToCache(llmRequest.contents);
    return {
      fingerprint: await generateCacheFingerprint(
        llmRequest,
        contentsCount,
        this.scope,
      ),
      contentsCount,
    };
  }

  private async isCacheValid(
    llmRequest: LlmRequest,
    cacheMetadata: ActiveCacheMetadata,
  ): Promise<boolean> {
    const {cacheName, expireTime, invocationsUsed} = cacheMetadata;
    const cacheConfig = requireCacheConfig(llmRequest);

    if (Date.now() / 1000 >= expireTime) {
      logger.info(`Cache expired: ${cacheName}`);
      return false;
    }

    if (invocationsUsed > cacheConfig.cacheIntervals) {
      logger.info(
        `Cache exceeded cache intervals: ${cacheName} ` +
          `(${invocationsUsed} > ${cacheConfig.cacheIntervals} intervals)`,
      );
      return false;
    }

    const currentFingerprint = await generateCacheFingerprint(
      llmRequest,
      cacheMetadata.contentsCount,
      this.scope,
    );
    if (currentFingerprint !== cacheMetadata.fingerprint) {
      logger.debug('Cache content fingerprint mismatch');
      return false;
    }

    return true;
  }

  /**
   * Creates a cache when the request clears every gate, and reports nothing
   * when it does not. A gate that fails leaves the request uncached rather
   * than failing the turn.
   */
  private async createNewCacheWithContents(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<ActiveCacheMetadata | undefined> {
    const cacheConfig = requireCacheConfig(llmRequest);

    const previousTokenCount = llmRequest.cacheableContentsTokenCount;
    if (previousTokenCount === undefined) {
      logger.info(
        'No previous token count available, skipping cache creation for ' +
          'initial request',
      );
      return undefined;
    }

    if (previousTokenCount < cacheConfig.minTokens) {
      logger.info(
        `Previous request too small for caching (${previousTokenCount} < ` +
          `${cacheConfig.minTokens} tokens)`,
      );
      return undefined;
    }

    // The accurate token count covers the whole previous prompt, while the
    // cache only holds the prefix. On a long conversation the full count can
    // clear the model's minimum while the prefix is far below it, which makes
    // the create call fail, so gate on the prefix.
    const prefixTokens = estimateCacheablePrefixTokens(
      llmRequest,
      cacheContentsCount,
    );
    const floor = minimumCacheTokens(llmRequest.model);
    if (floor !== undefined && prefixTokens < floor) {
      logger.info(
        `Cacheable prefix below Gemini minimum cache size (${prefixTokens} ` +
          `< ${floor} tokens)`,
      );
      return undefined;
    }

    try {
      return await this.createGeminiCache(llmRequest, cacheContentsCount);
    } catch (e: unknown) {
      logger.warn(`Failed to create cache: ${e}`);
      return undefined;
    }
  }

  private async createGeminiCache(
    llmRequest: LlmRequest,
    cacheContentsCount: number,
  ): Promise<ActiveCacheMetadata> {
    return tracer.startActiveSpan('create_cache', async (span) => {
      try {
        const cacheRequestConfig = requireCacheConfig(llmRequest);
        const model = requireModel(llmRequest);
        const config = llmRequest.config;

        const cacheContents = llmRequest.contents.slice(0, cacheContentsCount);
        const cacheConfig: CreateCachedContentConfig = {
          contents: cacheContents.length ? cacheContents : undefined,
          ttl: ttlString(cacheRequestConfig),
          displayName: `adk-cache-${Math.floor(Date.now() / 1000)}-${cacheContentsCount}contents`,
        };

        if (config?.systemInstruction) {
          cacheConfig.systemInstruction = config.systemInstruction;
        }
        const tools = declarativeTools(llmRequest);
        if (tools.length) {
          cacheConfig.tools = tools;
        }
        if (config?.toolConfig) {
          cacheConfig.toolConfig = config.toolConfig;
        }
        if (cacheRequestConfig.createHttpOptions) {
          cacheConfig.httpOptions = cacheRequestConfig.createHttpOptions;
        }

        span.setAttribute('cache_contents_count', cacheContentsCount);
        span.setAttribute('model', model);
        span.setAttribute('ttl_seconds', cacheRequestConfig.ttlSeconds);

        const cachedContent = await this.genaiClient.caches.create({
          model,
          config: cacheConfig,
        });
        const createdAt = Date.now() / 1000;
        const serverExpireTime = Date.parse(cachedContent.expireTime ?? '');
        const expireTime = Number.isNaN(serverExpireTime)
          ? createdAt + cacheRequestConfig.ttlSeconds
          : serverExpireTime / 1000;

        const cacheName = cachedContent.name;
        if (!cacheName) {
          throw new Error('The cache service returned no cache name.');
        }
        logger.info(`Cache created successfully: ${cacheName}`);
        span.setAttribute('cache_name', cacheName);

        return {
          cacheName,
          expireTime,
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
