/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Fields common to every cache state. */
interface CacheMetadataBase {
  /**
   * Hash of the cacheable contents (instruction + tools + contents). Always
   * present, used for prefix matching.
   */
  readonly fingerprint: string;

  /**
   * Number of contents: the cached contents when an active cache exists,
   * otherwise the cacheable content prefix used for fingerprinting.
   */
  readonly contentsCount: number;
}

/**
 * An active context cache: it has been created, so it has a name, an expiry,
 * and a usage count.
 */
export interface ActiveCacheMetadata extends CacheMetadataBase {
  /**
   * Full resource name of the cached content (e.g.
   * `projects/123/locations/us-central1/cachedContents/456`).
   */
  readonly cacheName: string;

  /** Unix timestamp (seconds) when the cache expires. */
  readonly expireTime: number;

  /** Number of invocations this cache has been used for. */
  readonly invocationsUsed: number;
}

/**
 * No cache exists yet: only the prefix hash is recorded, so a later turn can
 * tell whether the cacheable prefix still matches.
 */
export interface FingerprintCacheMetadata extends CacheMetadataBase {
  readonly cacheName?: undefined;
  readonly expireTime?: undefined;
  readonly invocationsUsed?: undefined;
}

/**
 * Metadata for the context cache associated with an LLM response.
 *
 * Stores cache identification, usage tracking, and lifecycle information for a
 * single cache instance. The two states are modelled as a discriminated union
 * on `cacheName`, so a partially-populated active cache is not representable:
 * checking `cacheName != null` narrows to {@link ActiveCacheMetadata} and makes
 * `expireTime`/`invocationsUsed` available without assertions.
 *
 * All fields are `readonly`: metadata is copied rather than mutated, mirroring
 * the frozen model in `adk-python`.
 *
 * Token counts live in `LlmResponse.usageMetadata` and are intentionally not
 * duplicated here.
 */
export type CacheMetadata = ActiveCacheMetadata | FingerprintCacheMetadata;
