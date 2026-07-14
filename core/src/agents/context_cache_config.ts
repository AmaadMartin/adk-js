/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration for context caching across all agents in an app.
 */
export interface ContextCacheConfig {
  /**
   * Maximum number of invocations to reuse the same cache before refreshing it.
   * Default: 10, min: 1, max: 100
   */
  cacheIntervals?: number;

  /**
   * Time-to-live for cache in seconds.
   * Default: 1800 (> 0)
   */
  ttlSeconds?: number;

  /**
   * Minimum prior-request tokens required to enable caching.
   * Default: 0 (>= 0)
   */
  minTokens?: number;
}

/**
 * Creates a {@link ContextCacheConfig} with validated defaults.
 *
 * @param params Optional partial {@link ContextCacheConfig}.
 * @returns A merged and validated {@link ContextCacheConfig}.
 */
export function createContextCacheConfig(
  params: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  const cacheIntervals = validateCacheIntervals(params.cacheIntervals ?? 10);
  const ttlSeconds = validateTtlSeconds(params.ttlSeconds ?? 1800);
  const minTokens = validateMinTokens(params.minTokens ?? 0);

  return {
    cacheIntervals,
    ttlSeconds,
    minTokens,
  };
}

/**
 * Get TTL as string format for cache creation (e.g. "1800s").
 */
export function getTtlString(config: ContextCacheConfig): string {
  return `${config.ttlSeconds ?? 1800}s`;
}

function validateCacheIntervals(value: number): number {
  if (value < 1 || value > 100) {
    throw new Error('cacheIntervals must be between 1 and 100 inclusive.');
  }
  return value;
}

function validateTtlSeconds(value: number): number {
  if (value <= 0) {
    throw new Error('ttlSeconds must be greater than 0.');
  }
  return value;
}

function validateMinTokens(value: number): number {
  if (value < 0) {
    throw new Error('minTokens must be greater than or equal to 0.');
  }
  return value;
}
