/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metadata for the context cache attached to an LLM response.
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
 * Creates a validated {@link CacheMetadata}.
 *
 * @param params The metadata fields.
 * @returns The same fields, once they satisfy the active-state invariant.
 * @throws Error if the three active-cache fields are partially set, or if a
 *     count is negative.
 */
export function createCacheMetadata(params: CacheMetadata): CacheMetadata {
  const activeFields = [
    params.cacheName,
    params.expireTime,
    params.invocationsUsed,
  ];
  const setCount = activeFields.filter((field) => field !== undefined).length;
  if (setCount !== 0 && setCount !== activeFields.length) {
    throw new Error(
      'cacheName, expireTime, and invocationsUsed must all be set (active ' +
        'cache) or all be undefined (fingerprint-only state)',
    );
  }
  if (params.invocationsUsed !== undefined && params.invocationsUsed < 0) {
    throw new Error('invocationsUsed must be greater than or equal to 0.');
  }
  if (params.contentsCount < 0) {
    throw new Error('contentsCount must be greater than or equal to 0.');
  }
  return {...params};
}
