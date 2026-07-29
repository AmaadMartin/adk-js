/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions} from '@google/genai';

/** Default maximum number of invocations to reuse a cache before refreshing. */
const DEFAULT_CACHE_INTERVALS = 10;
/** Default cache time-to-live, in seconds (30 minutes). */
const DEFAULT_TTL_SECONDS = 1800;
/** Default minimum prior-request token count required to enable caching. */
const DEFAULT_MIN_TOKENS = 0;
/** Upper bound on {@link ContextCacheConfig.cacheIntervals}. */
const MAX_CACHE_INTERVALS = 100;

/**
 * Configuration for context caching across all agents in an app.
 *
 * When this config is present on an `App`, context caching is enabled for all
 * LLM agents in the app; when absent, caching is disabled and behavior is
 * unchanged. Caching begins on the second turn of a session at the earliest and
 * requires the cacheable prefix to reach the model-specific minimum, so short or
 * single-turn sessions are never cached.
 */
export interface ContextCacheConfig {
  /**
   * Maximum number of invocations to reuse the same cache before refreshing it.
   * Must be between 1 and 100.
   */
  cacheIntervals: number;

  /** Time-to-live for the cache, in seconds. Must be greater than 0. */
  ttlSeconds: number;

  /**
   * Minimum prior-request prompt token count required to enable caching. Gates
   * on the previous request's actual prompt token count.
   */
  minTokens: number;

  /**
   * Optional HTTP options forwarded to the GenAI client when creating cached
   * content (e.g. to set a timeout). When unset the client's defaults apply.
   */
  createHttpOptions?: HttpOptions;
}

/**
 * Creates a {@link ContextCacheConfig} with default values.
 *
 * Default values applied when the corresponding field is absent from `params`:
 * - `cacheIntervals` → `10`
 * - `ttlSeconds` → `1800` (30 minutes)
 * - `minTokens` → `0`
 *
 * @param params - Optional partial {@link ContextCacheConfig} overriding defaults.
 * @returns A merged, validated {@link ContextCacheConfig} object.
 * @throws {RangeError} When a field falls outside its documented range.
 */
export function createContextCacheConfig(
  params: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  const config: ContextCacheConfig = {
    ...params,
    cacheIntervals: params.cacheIntervals ?? DEFAULT_CACHE_INTERVALS,
    ttlSeconds: params.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    minTokens: params.minTokens ?? DEFAULT_MIN_TOKENS,
  };
  validateContextCacheConfig(config);
  return config;
}

function validateContextCacheConfig(config: ContextCacheConfig): void {
  if (
    config.cacheIntervals < 1 ||
    config.cacheIntervals > MAX_CACHE_INTERVALS
  ) {
    throw new RangeError(
      `cacheIntervals must be between 1 and ${MAX_CACHE_INTERVALS}, got ${config.cacheIntervals}`,
    );
  }
  if (config.ttlSeconds <= 0) {
    throw new RangeError(
      `ttlSeconds must be greater than 0, got ${config.ttlSeconds}`,
    );
  }
  if (config.minTokens < 0) {
    throw new RangeError(
      `minTokens must be at least 0, got ${config.minTokens}`,
    );
  }
}
