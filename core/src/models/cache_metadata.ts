/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Metadata for the context cache associated with an LLM response.
 *
 * Stores cache identification, usage tracking, and lifecycle information for a
 * single cache instance. It can be in one of two states:
 *
 * 1. Active cache: `cacheName`, `expireTime`, and `invocationsUsed` are all set.
 * 2. Fingerprint-only: those three fields are unset; only `fingerprint` and
 *    `contentsCount` are present for prefix matching.
 *
 * Token counts live in `LlmResponse.usageMetadata` and are intentionally not
 * duplicated here.
 */
export interface CacheMetadata {
  /**
   * Full resource name of the cached content (e.g.
   * `projects/123/locations/us-central1/cachedContents/456`). Unset when no
   * active cache exists (fingerprint-only state).
   */
  cacheName?: string;

  /** Unix timestamp (seconds) when the cache expires. Unset when inactive. */
  expireTime?: number;

  /**
   * Hash of the cacheable contents (instruction + tools + contents). Always
   * present, used for prefix matching.
   */
  fingerprint: string;

  /** Number of invocations this cache has been used for. Unset when inactive. */
  invocationsUsed?: number;

  /**
   * Number of contents: the cached contents when an active cache exists,
   * otherwise the cacheable content prefix used for fingerprinting.
   */
  contentsCount: number;

  /** Unix timestamp (seconds) when the cache was created. Unset when inactive. */
  createdAt?: number;
}
