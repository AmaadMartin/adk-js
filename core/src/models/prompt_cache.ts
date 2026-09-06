/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared reading of {@link ContextCacheConfig} for models that cache a marked
 * prefix.
 *
 * Gemini caches by creating a server-side resource. Claude instead caches
 * whatever prefix the request marks, and a model reached through a proxy
 * inherits whichever of the two its provider implements. The parts of the
 * configuration that mean the same thing for every prefix-marking model live
 * here, so those callers cannot drift apart on what one configuration means.
 */

import {ContextCacheConfig} from '../agents/context_cache_config.js';
import {logger} from '../utils/logger.js';

import {LlmRequest} from './llm_request.js';

/**
 * The longest prefix cache a prefix-marking model offers is an hour, and it
 * costs more to write than the short-lived default. Only a configured lifetime
 * of at least an hour is worth that price.
 */
const ONE_HOUR_TTL_SECONDS = 3600;

/**
 * Returns the cache config governing this request, or undefined to not cache.
 *
 * @param llmRequest Request whose cache configuration is being resolved. It is
 *   read, never modified.
 * @return The cache config to honor, or undefined when the request should not
 *   be cached.
 */
export function resolveCacheConfig(
  llmRequest: LlmRequest,
): ContextCacheConfig | undefined {
  const cacheConfig = llmRequest.cacheConfig;
  if (!cacheConfig) {
    return undefined;
  }

  // `minTokens` gates on the previous turn's measured prompt size, the same
  // signal the Gemini path uses. That size is unknown on the first turn, where
  // marking a prefix costs nothing beyond writing the cache.
  const previousPromptTokens = llmRequest.cacheableContentsTokenCount;
  if (
    previousPromptTokens !== undefined &&
    previousPromptTokens < cacheConfig.minTokens
  ) {
    logger.debug(
      `Skipping cache breakpoints: the previous prompt of ` +
        `${previousPromptTokens} tokens is below the configured minimum of ` +
        `${cacheConfig.minTokens}.`,
    );
    return undefined;
  }

  return cacheConfig;
}

/**
 * Reports whether to ask for the hour-long cache instead of the default.
 *
 * An hour is the longest a prefix cache is kept, so a configured lifetime
 * beyond that gets an hour rather than what it asked for.
 */
export function useOneHourTtl(cacheConfig: ContextCacheConfig): boolean {
  return cacheConfig.ttlSeconds >= ONE_HOUR_TTL_SECONDS;
}
