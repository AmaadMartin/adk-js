/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {HttpOptions} from '@google/genai';

/** Default maximum invocations to reuse a cache before refreshing it. */
const DEFAULT_CACHE_INTERVALS = 10;
/** Default cache time-to-live in seconds (30 minutes). */
const DEFAULT_TTL_SECONDS = 1800;
/** Default minimum prior-request tokens required to enable caching. */
const DEFAULT_MIN_TOKENS = 0;

/** Inclusive lower bound for {@link ContextCacheConfig.cacheIntervals}. */
const MIN_CACHE_INTERVALS = 1;
/** Inclusive upper bound for {@link ContextCacheConfig.cacheIntervals}. */
const MAX_CACHE_INTERVALS = 100;

/**
 * Configuration for context caching across all agents in an app.
 *
 * The presence of this configuration on a request is the opt-in switch for
 * context caching; when it is absent, caching is disabled and requests behave
 * exactly as they do without caching.
 *
 * Context caching can significantly reduce cost and latency by reusing a
 * previously processed cacheable prefix (system instruction + tools + stable
 * leading contents) across multiple requests. Caching begins on the second turn
 * of a session at the earliest and requires the cacheable prefix to reach the
 * model-specific minimum, so short or single-turn sessions are never cached.
 */
export interface ContextCacheConfig {
  /**
   * Maximum number of invocations to reuse the same cache before refreshing it.
   * Must be within [1, 100]. Defaults to 10.
   */
  cacheIntervals?: number;
  /**
   * Time-to-live for the cache in seconds. Must be greater than 0. Defaults to
   * 1800 (30 minutes).
   */
  ttlSeconds?: number;
  /**
   * Minimum prior-request tokens required to enable caching. Gates on the
   * previous request's actual prompt token count, not an estimate of the
   * current request. Must be greater than or equal to 0. Defaults to 0.
   */
  minTokens?: number;
  /**
   * Optional HTTP options passed to the cache-create call (for example a
   * timeout). When the cache-create call exceeds the timeout it fails and the
   * request proceeds without caching. Uses the client's defaults when unset.
   */
  createHttpOptions?: HttpOptions;
}

/** Fully-resolved default context cache configuration (numeric fields set). */
export const DEFAULT_CONTEXT_CACHE_CONFIG: Readonly<
  Required<Omit<ContextCacheConfig, 'createHttpOptions'>>
> = Object.freeze({
  cacheIntervals: DEFAULT_CACHE_INTERVALS,
  ttlSeconds: DEFAULT_TTL_SECONDS,
  minTokens: DEFAULT_MIN_TOKENS,
});

/**
 * Creates a validated context cache configuration, filling defaults for any
 * omitted fields.
 *
 * @param partial Partial configuration whose set fields override the defaults.
 * @returns A frozen configuration with all numeric fields populated.
 * @throws {Error} If a provided value is out of range (`cacheIntervals` outside
 *   [1, 100], `ttlSeconds` not greater than 0, or `minTokens` negative).
 */
export function createContextCacheConfig(
  partial: ContextCacheConfig = {},
): Readonly<ContextCacheConfig> {
  const cacheIntervals = partial.cacheIntervals ?? DEFAULT_CACHE_INTERVALS;
  const ttlSeconds = partial.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const minTokens = partial.minTokens ?? DEFAULT_MIN_TOKENS;

  if (
    cacheIntervals < MIN_CACHE_INTERVALS ||
    cacheIntervals > MAX_CACHE_INTERVALS
  ) {
    throw new Error(
      `cacheIntervals must be between ${MIN_CACHE_INTERVALS} and ` +
        `${MAX_CACHE_INTERVALS}, got ${cacheIntervals}`,
    );
  }
  if (ttlSeconds <= 0) {
    throw new Error(`ttlSeconds must be greater than 0, got ${ttlSeconds}`);
  }
  if (minTokens < 0) {
    throw new Error(
      `minTokens must be greater than or equal to 0, got ${minTokens}`,
    );
  }

  return Object.freeze({
    cacheIntervals,
    ttlSeconds,
    minTokens,
    createHttpOptions: partial.createHttpOptions,
  });
}

/**
 * Returns the TTL as a duration string for cache creation (for example
 * `"1800s"`), falling back to the default TTL when unset.
 */
export function ttlString(config: ContextCacheConfig): string {
  return `${config.ttlSeconds ?? DEFAULT_TTL_SECONDS}s`;
}

/** Returns a readable string representation of the config for logging. */
export function contextCacheConfigToString(config: ContextCacheConfig): string {
  const cacheIntervals = config.cacheIntervals ?? DEFAULT_CACHE_INTERVALS;
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const minTokens = config.minTokens ?? DEFAULT_MIN_TOKENS;
  return (
    `ContextCacheConfig(cacheIntervals=${cacheIntervals}, ttl=${ttlSeconds}s, ` +
    `minTokens=${minTokens}, createHttpOptions=${config.createHttpOptions ?? 'undefined'})`
  );
}
