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
 * Options for constructing a {@link ContextCacheConfig}.
 */
export interface ContextCacheConfigOptions {
  /**
   * Maximum number of invocations to reuse the same cache before refreshing it.
   * Must be between 1 and 100. Defaults to 10.
   */
  cacheIntervals?: number;

  /**
   * Time-to-live for the cache, in seconds. Must be greater than 0. Defaults to
   * 1800 (30 minutes).
   */
  ttlSeconds?: number;

  /**
   * Minimum prior-request prompt token count required to enable caching. Gates
   * on the previous request's actual prompt token count. Defaults to 0.
   */
  minTokens?: number;

  /**
   * Optional HTTP options forwarded to the GenAI client when creating cached
   * content (e.g. to set a timeout). When unset the client's defaults apply.
   */
  createHttpOptions?: HttpOptions;
}

/**
 * Configuration for context caching across all agents in an app.
 *
 * When this config is present on an {@link App}, context caching is enabled for
 * all LLM agents in the app; when absent, caching is disabled and behavior is
 * unchanged. Caching begins on the second turn of a session at the earliest and
 * requires the cacheable prefix to reach the model-specific minimum, so short or
 * single-turn sessions are never cached.
 */
export class ContextCacheConfig {
  readonly cacheIntervals: number;
  readonly ttlSeconds: number;
  readonly minTokens: number;
  readonly createHttpOptions?: HttpOptions;

  constructor(options: ContextCacheConfigOptions = {}) {
    const cacheIntervals = options.cacheIntervals ?? DEFAULT_CACHE_INTERVALS;
    const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;

    if (cacheIntervals < 1 || cacheIntervals > MAX_CACHE_INTERVALS) {
      throw new RangeError(
        `cacheIntervals must be between 1 and ${MAX_CACHE_INTERVALS}, got ${cacheIntervals}`,
      );
    }
    if (ttlSeconds <= 0) {
      throw new RangeError(
        `ttlSeconds must be greater than 0, got ${ttlSeconds}`,
      );
    }
    if (minTokens < 0) {
      throw new RangeError(`minTokens must be at least 0, got ${minTokens}`);
    }

    this.cacheIntervals = cacheIntervals;
    this.ttlSeconds = ttlSeconds;
    this.minTokens = minTokens;
    this.createHttpOptions = options.createHttpOptions;
  }
}
