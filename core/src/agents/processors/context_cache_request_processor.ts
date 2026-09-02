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

/** Thrown when a live cache carries no use count. */
const MISSING_INVOCATIONS_USED_ERROR =
  'Active cache metadata must include invocations_used.';

/** What a walk back through the session found for the current agent. */
interface SessionCacheInfo {
  /** The most recent cache metadata, ready to carry into this request. */
  cacheMetadata?: CacheMetadata;
  /** The most recent prompt token count the model reported. */
  previousTokenCount?: number;
}

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
    throw new Error(MISSING_INVOCATIONS_USED_ERROR);
  }
  return {...metadata, invocationsUsed: metadata.invocationsUsed + 1};
}

/**
 * Walks the session from the newest event back, collecting the agent's latest
 * cache metadata and its latest prompt token count. The two can sit on
 * different events, so the walk stops once it holds both.
 */
function findCacheInfoFromEvents(
  events: Event[],
  agentName: string,
  currentInvocationId: string,
): SessionCacheInfo {
  const info: SessionCacheInfo = {};
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== agentName) {
      continue;
    }
    if (info.cacheMetadata === undefined && event.cacheMetadata) {
      info.cacheMetadata = carryForwardCacheMetadata(
        event.cacheMetadata,
        event.invocationId,
        currentInvocationId,
      );
    }
    const promptTokenCount = event.usageMetadata?.promptTokenCount;
    if (
      info.previousTokenCount === undefined &&
      promptTokenCount !== undefined
    ) {
      info.previousTokenCount = promptTokenCount;
    }
    if (
      info.cacheMetadata !== undefined &&
      info.previousTokenCount !== undefined
    ) {
      break;
    }
  }
  return info;
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
    const agentName = requireAgent(invocationContext).name;
    const cacheConfig = invocationContext.contextCacheConfig;
    if (!cacheConfig) {
      return;
    }

    llmRequest.cacheConfig = cacheConfig;

    const {cacheMetadata, previousTokenCount} = findCacheInfoFromEvents(
      invocationContext.session.events,
      agentName,
      invocationContext.invocationId,
    );
    if (cacheMetadata !== undefined) {
      llmRequest.cacheMetadata = cacheMetadata;
    }
    if (previousTokenCount !== undefined) {
      llmRequest.cacheableContentsTokenCount = previousTokenCount;
    }
  }
}

/** The shared context cache request processor. */
export const CONTEXT_CACHE_REQUEST_PROCESSOR =
  new ContextCacheRequestProcessor();
