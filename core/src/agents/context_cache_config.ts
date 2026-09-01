/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions} from '@google/genai';

import {NumberRange, requireInRange} from '../utils/number_utils.js';

const DEFAULT_CACHE_INTERVALS = 10;
const DEFAULT_TTL_SECONDS = 1800;
const DEFAULT_MIN_TOKENS = 0;

const BOUNDS: Record<string, NumberRange> = {
  cacheIntervals: {min: 1, max: 100},
  ttlSeconds: {min: 1},
  minTokens: {min: 0},
};

/**
 * Controls context caching for every LLM agent in an app.
 *
 * Caching begins on the second turn of a session at the earliest, because the
 * decision needs a previous prompt token count. Mirrors `google/adk-python`
 * `ContextCacheConfig`.
 */
export interface ContextCacheConfig {
  /** How many invocations reuse one cache before it is refreshed. */
  cacheIntervals: number;

  /** How long the cache lives, in seconds. */
  ttlSeconds: number;

  /**
   * The previous request's prompt token count required before a cache is
   * created. The model's own minimum still applies on top of this.
   */
  minTokens: number;

  /**
   * HTTP options for the cache-creation call, e.g. a timeout. When the call
   * exceeds it, the request proceeds without caching.
   */
  createHttpOptions?: HttpOptions;
}

/**
 * Creates a {@link ContextCacheConfig}, applying defaults and rejecting a
 * value outside its bounds.
 *
 * @param params Optional partial config overriding the defaults.
 * @returns The merged, validated config.
 * @throws {Error} When `cacheIntervals` is outside 1..100, `ttlSeconds` is
 *   below 1, or `minTokens` is negative.
 */
export function createContextCacheConfig(
  params: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  const config: ContextCacheConfig = {
    cacheIntervals: DEFAULT_CACHE_INTERVALS,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    minTokens: DEFAULT_MIN_TOKENS,
    ...params,
  };
  requireInRange(
    'cacheIntervals',
    config.cacheIntervals,
    BOUNDS.cacheIntervals,
  );
  requireInRange('ttlSeconds', config.ttlSeconds, BOUNDS.ttlSeconds);
  requireInRange('minTokens', config.minTokens, BOUNDS.minTokens);
  return config;
}

/**
 * Renders the TTL in the duration format the cache-creation API expects.
 *
 * Mirrors `ContextCacheConfig.ttl_string` in `google/adk-python`.
 */
export function contextCacheTtlString(config: ContextCacheConfig): string {
  return `${config.ttlSeconds}s`;
}
