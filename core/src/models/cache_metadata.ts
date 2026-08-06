/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metadata for a context cache associated with LLM responses.
 *
 * Stores cache identification, usage tracking, and lifecycle information for a
 * particular cache instance. Two logical states are representable:
 *
 *  1. Active cache:      `cacheName`, `expireTime`, and `invocationsUsed` are
 *                        all set.
 *  2. Fingerprint-only:  those three are undefined; only `fingerprint` and
 *                        `contentsCount` are set (used for prefix matching).
 *
 * Token counts (cached and total) live on `LlmResponse.usageMetadata`, not
 * here, to avoid duplication.
 */
export interface CacheMetadata {
  /**
   * Full resource name of the cached content (e.g.
   * `projects/123/locations/us-central1/cachedContents/456`). Undefined when no
   * active cache exists (fingerprint-only state).
   */
  cacheName?: string;

  /**
   * Unix timestamp (seconds) when the cache expires. Undefined when no active
   * cache exists.
   */
  expireTime?: number;

  /**
   * Hash of the cacheable contents (instruction + tools + contents) used to
   * detect changes. Always present for prefix matching.
   */
  fingerprint: string;

  /**
   * Number of invocations this cache has been used for. Undefined when no
   * active cache exists.
   */
  invocationsUsed?: number;

  /**
   * Number of contents: the count of cached contents when an active cache
   * exists, or the count of the cacheable content prefix when no active cache
   * exists.
   */
  contentsCount: number;

  /**
   * Unix timestamp (seconds) when the cache was created. Undefined when no
   * active cache exists.
   */
  createdAt?: number;
}
