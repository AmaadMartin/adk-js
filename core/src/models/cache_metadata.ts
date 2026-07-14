/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metadata for context cache associated with LLM responses.
 */
export interface CacheMetadata {
  /**
   * Full resource name of the cached content (undefined if no active cache).
   */
  cacheName?: string;

  /**
   * Unix timestamp in seconds when cache expires (undefined if no active cache).
   */
  expireTime?: number;

  /**
   * Hash of cacheable contents used to detect changes.
   */
  fingerprint: string;

  /**
   * Number of invocations this cache has been used for (undefined if no active cache).
   */
  invocationsUsed?: number;

  /**
   * Number of contents (cached contents when active cache exists,
   * cacheable content prefix when no active cache).
   */
  contentsCount: number;

  /**
   * Unix timestamp in seconds when cache was created (undefined if no active cache).
   */
  createdAt?: number;
}

/**
 * Creates and validates a {@link CacheMetadata} object.
 * Enforces that `cacheName`, `expireTime`, and `invocationsUsed` are either
 * all defined (active cache) or all undefined (fingerprint-only state).
 *
 * @param params The cache metadata properties.
 * @returns Validated {@link CacheMetadata}.
 */
export function createCacheMetadata(params: CacheMetadata): CacheMetadata {
  const activeFieldsCount = [
    params.cacheName !== undefined,
    params.expireTime !== undefined,
    params.invocationsUsed !== undefined,
  ].filter(Boolean).length;

  if (activeFieldsCount !== 0 && activeFieldsCount !== 3) {
    throw new Error(
      'cacheName, expireTime, and invocationsUsed must all be set (active cache) or all be undefined (fingerprint-only state)',
    );
  }

  return {
    ...params,
  };
}
