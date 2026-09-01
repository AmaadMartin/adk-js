/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A cache is refreshed this many seconds before it actually expires, so a
 * request that is already in flight cannot outlive it.
 */
const EXPIRY_BUFFER_SECONDS = 120;

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Metadata for the context cache associated with an LLM response.
 *
 * A record is in one of two states:
 *
 * 1. Active cache: `cacheName`, `expireTime` and `invocationsUsed` are all set.
 * 2. Fingerprint only: those three fields are all absent, and only
 *    `fingerprint` and `contentsCount` describe the cacheable prefix.
 *
 * Token counts live on `LlmResponse.usageMetadata` and are not duplicated
 * here.
 */
export interface CacheMetadata {
  /**
   * Full resource name of the cached content, for example
   * `projects/123/locations/us-central1/cachedContents/456`. Absent when no
   * active cache exists.
   */
  cacheName?: string;

  /** Unix timestamp in seconds when the cache expires. */
  expireTime?: number;

  /**
   * Hash of the cacheable contents (system instruction, tools and contents).
   * Always present, so a later request can match the same prefix.
   */
  fingerprint: string;

  /** Number of invocations this cache has served. */
  invocationsUsed?: number;

  /**
   * Number of contents. With an active cache this counts the cached contents.
   * Otherwise it counts the cacheable prefix used for the fingerprint.
   */
  contentsCount: number;

  /** Unix timestamp in seconds when the cache was created. */
  createdAt?: number;
}

/**
 * Creates a {@link CacheMetadata} and enforces its state invariant.
 *
 * @param params The metadata fields.
 * @returns The validated metadata.
 * @throws Error if the active-cache fields are partially set, or if a count is
 *     negative.
 */
export function createCacheMetadata(params: CacheMetadata): CacheMetadata {
  const activeFieldsSet = [
    params.cacheName,
    params.expireTime,
    params.invocationsUsed,
  ].map((field) => field !== undefined);

  if (new Set(activeFieldsSet).size > 1) {
    throw new Error(
      'cacheName, expireTime, and invocationsUsed must all be set (active ' +
        'cache) or all be undefined (fingerprint-only state)',
    );
  }

  if (params.invocationsUsed !== undefined && params.invocationsUsed < 0) {
    throw new Error('invocationsUsed must not be negative');
  }

  if (params.contentsCount < 0) {
    throw new Error('contentsCount must not be negative');
  }

  return params;
}

/**
 * Whether the cache expires within the refresh buffer.
 *
 * @param metadata The cache metadata to check.
 * @returns `false` when the metadata carries no expiry.
 */
export function cacheExpiresSoon(metadata: CacheMetadata): boolean {
  if (metadata.expireTime === undefined) {
    return false;
  }
  return (
    Date.now() / MILLISECONDS_PER_SECOND >
    metadata.expireTime - EXPIRY_BUFFER_SECONDS
  );
}
