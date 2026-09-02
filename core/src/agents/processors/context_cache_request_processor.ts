/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {CacheMetadata} from '../../models/cache_metadata.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext, requireAgent} from '../invocation_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Returns the metadata to send with this request: always a copy, so the
 * session's own event keeps its recorded state.
 *
 * A live cache that crosses an invocation boundary has served one more
 * invocation, so its use count goes up by one. A cache reused inside the
 * invocation that created it, and a fingerprint with no cache behind it, carry
 * their counts through unchanged.
 */
function carryForwardCacheMetadata(
  metadata: CacheMetadata,
  eventInvocationId: string | undefined,
  currentInvocationId: string,
): CacheMetadata {
  const isEarlierInvocation =
    !!eventInvocationId && eventInvocationId !== currentInvocationId;
  if (!isEarlierInvocation || metadata.cacheName === undefined) {
    return {...metadata};
  }
  // The union rules this out at compile time, but a session read back from
  // storage is not type-checked.
  if (typeof metadata.invocationsUsed !== 'number') {
    throw new Error('Active cache metadata must include invocations_used.');
  }
  return {...metadata, invocationsUsed: metadata.invocationsUsed + 1};
}

/**
 * Walks the session from the newest event back, writing the agent's latest
 * cache metadata and its latest prompt token count onto the request. The two
 * can sit on different events, so the walk stops once it has written both.
 */
function applyCacheInfoFromEvents(
  llmRequest: LlmRequest,
  events: Event[],
  agentName: string,
  currentInvocationId: string,
): void {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== agentName) {
      continue;
    }
    if (llmRequest.cacheMetadata === undefined && event.cacheMetadata) {
      llmRequest.cacheMetadata = carryForwardCacheMetadata(
        event.cacheMetadata,
        event.invocationId,
        currentInvocationId,
      );
    }
    const promptTokenCount = event.usageMetadata?.promptTokenCount;
    if (
      llmRequest.cacheableContentsTokenCount === undefined &&
      promptTokenCount !== undefined
    ) {
      llmRequest.cacheableContentsTokenCount = promptTokenCount;
    }
    if (
      llmRequest.cacheMetadata !== undefined &&
      llmRequest.cacheableContentsTokenCount !== undefined
    ) {
      break;
    }
  }
}

/**
 * Stages context caching for the request.
 *
 * It publishes the app's cache configuration on the request, and hands the
 * model layer what it needs to decide between reusing and refreshing a cache:
 * the previous turn's cache metadata and its prompt token count. Creating,
 * reusing and expiring the cache itself belongs to the model layer.
 *
 * An app with no cache configuration leaves the request untouched.
 */
export class ContextCacheRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Populates the request's caching fields, or leaves the request untouched
   * when the app configures no context cache.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request to populate.
   */
  // eslint-disable-next-line require-yield -- BaseLlmRequestProcessor mandates an AsyncGenerator; this processor only mutates the request.
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const cacheConfig = invocationContext.contextCacheConfig;
    if (!cacheConfig) {
      return;
    }

    llmRequest.cacheConfig = cacheConfig;
    applyCacheInfoFromEvents(
      llmRequest,
      invocationContext.session.events,
      requireAgent(invocationContext).name,
      invocationContext.invocationId,
    );
  }
}

/** The shared context cache request processor. */
export const CONTEXT_CACHE_REQUEST_PROCESSOR =
  new ContextCacheRequestProcessor();
