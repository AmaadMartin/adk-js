/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions} from '@google/genai';

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
   * Minimum estimated request tokens required to enable caching. Context cache
   * storage may have a cost, so set this higher to avoid caching a small
   * request where the overhead exceeds the benefit. Must be a non-negative
   * integer.
   */
  minTokens: number;

  /** HTTP options for the cache-creation call. */
  createHttpOptions?: HttpOptions;
}
