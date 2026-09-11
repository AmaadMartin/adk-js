/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The bounds an {@link AudioCacheManager} advertises for its realtime audio
 * caches.
 *
 * The bounds are advisory. The manager carries the config and reads none of
 * its three fields, so it never flushes on its own; adk-python's
 * `AudioCacheConfig` behaves the same way. Read the fields from your own live
 * loop and call {@link AudioCacheManager.flushCaches} when one is exceeded.
 */
export interface AudioCacheConfig {
  /** Maximum cache size in bytes before an auto-flush. */
  maxCacheSizeBytes: number;

  /** Maximum time to keep data in the cache, in seconds. */
  maxCacheDurationSeconds: number;

  /** Number of chunks that triggers an auto-flush. */
  autoFlushThreshold: number;
}

/**
 * Creates an {@link AudioCacheConfig} with the defaults adk-python applies.
 *
 * Defaults: `maxCacheSizeBytes` 10485760, `maxCacheDurationSeconds` 300,
 * `autoFlushThreshold` 100.
 *
 * @param params - Optional partial {@link AudioCacheConfig} overriding the
 *     defaults. The object is read, never mutated.
 * @returns A new, fully populated {@link AudioCacheConfig}.
 */
export function createAudioCacheConfig(
  params: Partial<AudioCacheConfig> = {},
): AudioCacheConfig {
  // adk-python's AudioCacheConfig has no validators, so no bound is rejected
  // here either.
  return {
    maxCacheSizeBytes: 10 * 1024 * 1024, // 10 MiB
    maxCacheDurationSeconds: 300, // 5 minutes
    autoFlushThreshold: 100,
    ...params,
  };
}
