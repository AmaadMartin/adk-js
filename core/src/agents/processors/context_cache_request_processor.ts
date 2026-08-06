/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {CacheMetadata} from '../../models/cache_metadata.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Request processor that enables context caching for LLM requests.
 *
 * When the invocation carries a `contextCacheConfig`, this processor copies it
 * onto the request and recovers, from prior session events, the latest cache
 * metadata and the previous turn's prompt token count. The actual cache
 * lifecycle is handled by the model-specific cache manager (e.g. the Gemini
 * cache manager); this processor only supplies the inputs it reads.
 */
export class ContextCacheRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Populates the request's cache config, metadata, and previous token count
   * when context caching is enabled. Yields no events.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request object to populate in place.
   */
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const {contextCacheConfig} = invocationContext;
    if (!contextCacheConfig) {
      return;
    }

    llmRequest.cacheConfig = contextCacheConfig;

    const {cacheMetadata, previousTokenCount} =
      findCacheInfoFromEvents(invocationContext);
    llmRequest.cacheMetadata = cacheMetadata;
    llmRequest.cacheableContentsTokenCount = previousTokenCount;
  }
}

/**
 * Scans the session's events, most-recent-first, for the current agent's latest
 * cache metadata and previous prompt token count.
 *
 * Only events authored by the current agent are considered. The metadata is
 * copied (never mutated in place); its `invocationsUsed` count is incremented by
 * one only when the source event comes from a different, completed invocation
 * that has an active cache. The scan stops as soon as both pieces of information
 * are found.
 *
 * @param invocationContext - The context whose session events are scanned.
 * @returns The recovered cache metadata and previous token count, if any.
 */
function findCacheInfoFromEvents(invocationContext: InvocationContext): {
  cacheMetadata?: CacheMetadata;
  previousTokenCount?: number;
} {
  const agentName = invocationContext.agent.name;
  const currentInvocationId = invocationContext.invocationId;
  const events = invocationContext.session.events;

  let cacheMetadata: CacheMetadata | undefined;
  let previousTokenCount: number | undefined;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== agentName) {
      continue;
    }

    if (cacheMetadata === undefined && event.cacheMetadata !== undefined) {
      const source = event.cacheMetadata;
      cacheMetadata =
        source.cacheName != null &&
        event.invocationId &&
        event.invocationId !== currentInvocationId
          ? {...source, invocationsUsed: source.invocationsUsed + 1}
          : {...source};
    }

    if (
      previousTokenCount === undefined &&
      event.usageMetadata?.promptTokenCount !== undefined
    ) {
      previousTokenCount = event.usageMetadata.promptTokenCount;
    }

    if (cacheMetadata !== undefined && previousTokenCount !== undefined) {
      break;
    }
  }

  return {cacheMetadata, previousTokenCount};
}

export const CONTEXT_CACHE_REQUEST_PROCESSOR =
  new ContextCacheRequestProcessor();
