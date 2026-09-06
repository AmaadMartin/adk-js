/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const DEFAULT_CACHE_INTERVALS = 10;
const MIN_CACHE_INTERVALS = 1;
const MAX_CACHE_INTERVALS = 100;

/** Thirty minutes. */
const DEFAULT_TTL_SECONDS = 1800;

const DEFAULT_MIN_TOKENS = 0;

/**
 * Configuration for context caching across all agents in an app.
 *
 * Context caching reuses previously processed context across requests, which
 * lowers cost and response time. When this config is present on an app,
 * context caching is enabled for every LLM agent in that app. When it is
 * absent, context caching is disabled.
 *
 * WARNING: This feature is **experimental** and its API or behavior may
 * change in future releases.
 */
export interface ContextCacheConfig {
  /**
   * Maximum number of invocations to reuse the same cache before refreshing
   * it. Must be an integer from 1 to 100.
   */
  cacheIntervals: number;

  /** Time-to-live for cache in seconds. Must be an integer above 0. */
  ttlSeconds: number;

  /**
   * Minimum estimated request tokens required to enable caching. This compares
   * against the estimated total tokens of the request (system instruction +
   * tools + contents). Context cache storage may have cost. Set higher to
   * avoid caching small requests where overhead may exceed benefits. Must be a
   * non-negative integer.
   */
  minTokens: number;
}

/**
 * Creates a {@link ContextCacheConfig} with default values.
 *
 * An unknown key is a compile error, because `Partial<ContextCacheConfig>`
 * makes TypeScript apply excess-property checking to an object literal. That
 * is the counterpart of adk-python's `extra="forbid"`.
 *
 * @param params Optional partial {@link ContextCacheConfig} overriding
 *     defaults.
 * @returns A merged {@link ContextCacheConfig} object.
 * @throws Error if a field is not an integer or falls outside its bounds.
 */
export function createContextCacheConfig(
  params: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  const config = {
    cacheIntervals: DEFAULT_CACHE_INTERVALS,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    minTokens: DEFAULT_MIN_TOKENS,
    ...params,
  };

  // adk-python types every field as `int`, so pydantic rejects a fractional
  // value and TypeScript `number` does not. This also rejects NaN and Infinity.
  for (const [field, value] of Object.entries(config)) {
    if (!Number.isInteger(value)) {
      throw new Error(`${field} must be an integer.`);
    }
  }

  if (config.cacheIntervals < MIN_CACHE_INTERVALS) {
    throw new Error(
      `cacheIntervals must be greater than or equal to ${MIN_CACHE_INTERVALS}.`,
    );
  }
  if (config.cacheIntervals > MAX_CACHE_INTERVALS) {
    throw new Error(
      `cacheIntervals must be less than or equal to ${MAX_CACHE_INTERVALS}.`,
    );
  }
  if (config.ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be greater than 0.');
  }
  if (config.minTokens < 0) {
    throw new Error('minTokens must be greater than or equal to 0.');
  }

  return config;
}
