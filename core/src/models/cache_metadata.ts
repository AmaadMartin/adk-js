/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Buffer (seconds) before actual expiry at which a cache is "expiring soon". */
const EXPIRE_SOON_BUFFER_SECONDS = 120;
/** Number of leading fingerprint characters shown in log output. */
const FINGERPRINT_LOG_PREFIX_LENGTH = 8;

/**
 * Metadata for a context cache associated with LLM responses.
 *
 * A record can be in one of two states:
 *
 * 1. Active cache state: `cacheName`, `expireTime`, and `invocationsUsed` are
 *    all set and the record describes a live cache.
 * 2. Fingerprint-only state: those three fields are all undefined and only
 *    `fingerprint` and `contentsCount` are meaningful (used for prefix matching
 *    before a cache exists).
 *
 * Records are immutable; use {@link createCacheMetadata} to construct them.
 */
export interface CacheMetadata {
  /**
   * Full resource name of the cached content. Undefined in the
   * fingerprint-only state.
   */
  cacheName?: string;
  /**
   * Unix timestamp (seconds) when the cache expires. Undefined when there is
   * no active cache.
   */
  expireTime?: number;
  /**
   * Hash of the cacheable contents (system instruction + tools + prefix).
   * Always present.
   */
  fingerprint: string;
  /**
   * Number of invocations this cache has served. Undefined when there is no
   * active cache.
   */
  invocationsUsed?: number;
  /**
   * Count of cached contents (active state) or the cacheable-prefix length
   * (fingerprint-only state).
   */
  contentsCount: number;
  /**
   * Unix timestamp (seconds) when the cache was created. Undefined when there
   * is no active cache.
   */
  createdAt?: number;
}

/**
 * Creates a validated, immutable {@link CacheMetadata} record.
 *
 * @param fields The metadata fields.
 * @returns A frozen `CacheMetadata`.
 * @throws {Error} If the active-state invariant is broken (`cacheName`,
 *   `expireTime`, and `invocationsUsed` must be all set or all undefined) or if
 *   `invocationsUsed` or `contentsCount` is negative.
 */
export function createCacheMetadata(
  fields: CacheMetadata,
): Readonly<CacheMetadata> {
  const activePresence = [
    fields.cacheName !== undefined,
    fields.expireTime !== undefined,
    fields.invocationsUsed !== undefined,
  ];
  const allSet = activePresence.every(Boolean);
  const noneSet = activePresence.every((present) => !present);
  if (!allSet && !noneSet) {
    throw new Error(
      'cacheName, expireTime, and invocationsUsed must all be set (active ' +
        'cache) or all be undefined (fingerprint-only state)',
    );
  }
  if (fields.invocationsUsed !== undefined && fields.invocationsUsed < 0) {
    throw new Error(
      `invocationsUsed must be greater than or equal to 0, got ${fields.invocationsUsed}`,
    );
  }
  if (fields.contentsCount < 0) {
    throw new Error(
      `contentsCount must be greater than or equal to 0, got ${fields.contentsCount}`,
    );
  }

  return Object.freeze({
    cacheName: fields.cacheName,
    expireTime: fields.expireTime,
    fingerprint: fields.fingerprint,
    invocationsUsed: fields.invocationsUsed,
    contentsCount: fields.contentsCount,
    createdAt: fields.createdAt,
  });
}

/** Returns an immutable copy of the given metadata. */
export function copyCacheMetadata(
  meta: CacheMetadata,
): Readonly<CacheMetadata> {
  return Object.freeze({...meta});
}

/**
 * Returns whether the cache will expire soon (within a 2-minute buffer).
 * Always false for fingerprint-only metadata (no `expireTime`).
 */
export function cacheExpireSoon(meta: CacheMetadata): boolean {
  if (meta.expireTime === undefined) {
    return false;
  }
  return Date.now() / 1000 > meta.expireTime - EXPIRE_SOON_BUFFER_SECONDS;
}

/** Returns a readable string representation of the metadata for logging. */
export function cacheMetadataToString(meta: CacheMetadata): string {
  if (meta.cacheName === undefined) {
    return (
      `Fingerprint-only: ${meta.contentsCount} contents, ` +
      `fingerprint=${meta.fingerprint.slice(0, FINGERPRINT_LOG_PREFIX_LENGTH)}...`
    );
  }
  const cacheId = meta.cacheName.split('/').pop();
  const minutesUntilExpiry = (meta.expireTime! - Date.now() / 1000) / 60;
  return (
    `Cache ${cacheId}: used ${meta.invocationsUsed} invocations, ` +
    `cached ${meta.contentsCount} contents, ` +
    `expires in ${minutesUntilExpiry.toFixed(1)}min`
  );
}
