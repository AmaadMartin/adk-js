/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions} from '@google/genai';

const DEFAULT_CACHE_INTERVALS = 10;

/** Thirty minutes. */
const DEFAULT_TTL_SECONDS = 1800;

const DEFAULT_MIN_TOKENS = 0;
const MIN_CACHE_INTERVALS = 1;
const MAX_CACHE_INTERVALS = 100;

const CONTEXT_CACHE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'cacheIntervals',
  'ttlSeconds',
  'minTokens',
  'createHttpOptions',
]);

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

  /** Time-to-live for the cache in seconds. Must be an integer above 0. */
  ttlSeconds: number;

  /**
   * Minimum prior-request tokens required to enable caching. This gates on the
   * previous request's actual prompt token count, not an estimate of the
   * current request. Context cache storage may have a cost, so set this higher
   * to avoid caching a small request where the overhead exceeds the benefit.
   * Must be a non-negative integer.
   */
  minTokens: number;

  /** HTTP options for the cache-creation call. */
  createHttpOptions?: HttpOptions;
}

/** Bounds an integer field must satisfy. */
interface IntegerRange {
  /** Inclusive lower bound. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  /** Exclusive lower bound. */
  exclusiveMin?: number;
}

/**
 * Creates a {@link ContextCacheConfig} with the defaults adk-python applies.
 *
 * Defaults: `cacheIntervals` 10, `ttlSeconds` 1800, `minTokens` 0.
 * `createHttpOptions` has no default and stays absent unless supplied.
 *
 * @param params - Optional partial {@link ContextCacheConfig} overriding the
 *     defaults. The object is read, never mutated.
 * @returns A new, fully populated {@link ContextCacheConfig}.
 * @throws {Error} When `params` carries a key that is not a
 *     {@link ContextCacheConfig} field.
 * @throws {Error} When a field is not an integer or falls outside its bounds.
 */
export function createContextCacheConfig(
  params: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  rejectUnknownKeys(params);

  const config: ContextCacheConfig = {
    cacheIntervals: DEFAULT_CACHE_INTERVALS,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    minTokens: DEFAULT_MIN_TOKENS,
    ...params,
  };

  requireIntegerInRange('cacheIntervals', config.cacheIntervals, {
    min: MIN_CACHE_INTERVALS,
    max: MAX_CACHE_INTERVALS,
  });
  requireIntegerInRange('ttlSeconds', config.ttlSeconds, {exclusiveMin: 0});
  requireIntegerInRange('minTokens', config.minTokens, {min: 0});

  return config;
}

/**
 * Renders the time-to-live in the form `CachedContent.create()` expects.
 *
 * @param config - The context cache configuration to read.
 * @returns The time-to-live in seconds with an `s` suffix, e.g. `'1800s'`.
 */
export function contextCacheTtlString(config: ContextCacheConfig): string {
  return `${config.ttlSeconds}s`;
}

/**
 * Renders a {@link ContextCacheConfig} as a single line for a debug log.
 *
 * @param config - The context cache configuration to render.
 * @returns A line such as
 *     `ContextCacheConfig(cacheIntervals=10, ttl=1800s, minTokens=0, createHttpOptions=undefined)`.
 */
export function formatContextCacheConfig(config: ContextCacheConfig): string {
  const createHttpOptions =
    config.createHttpOptions === undefined
      ? 'undefined'
      : JSON.stringify(config.createHttpOptions);
  return (
    `ContextCacheConfig(cacheIntervals=${config.cacheIntervals}, ` +
    `ttl=${contextCacheTtlString(config)}, minTokens=${config.minTokens}, ` +
    `createHttpOptions=${createHttpOptions})`
  );
}

function rejectUnknownKeys(params: Partial<ContextCacheConfig>): void {
  const unknownKeys = Object.keys(params).filter(
    (key) => !CONTEXT_CACHE_CONFIG_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown context cache config key(s): ${unknownKeys.join(', ')}. ` +
        'Extra keys are not allowed.',
    );
  }
}

function requireIntegerInRange(
  name: string,
  value: number,
  range: IntegerRange,
): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer; got ${value}.`);
  }
  if (range.min !== undefined && value < range.min) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${range.min}; got ${value}.`,
    );
  }
  if (range.max !== undefined && value > range.max) {
    throw new Error(
      `${name} must be an integer less than or equal to ${range.max}; got ${value}.`,
    );
  }
  if (range.exclusiveMin !== undefined && value <= range.exclusiveMin) {
    throw new Error(
      `${name} must be an integer greater than ${range.exclusiveMin}; got ${value}.`,
    );
  }
}
