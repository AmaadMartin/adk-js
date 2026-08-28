/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {CacheMetadata} from '../../models/cache_metadata.js';
import {LlmRequest} from '../../models/llm_request.js';
import {logger} from '../../utils/logger.js';
import {InvocationContext, requireAgent} from '../invocation_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/** What one reverse pass over the session history can recover. */
interface CacheInfo {
  cacheMetadata?: CacheMetadata;
  previousTokenCount?: number;
}

/**
 * Puts the context caching policy and the session's carried-over cache state
 * on the outgoing {@link LlmRequest}.
 *
 * Creating, reusing and expiring the cached content itself belongs to a
 * model-specific cache manager. This processor only reads the session history
 * and populates the request.
 */
export class ContextCacheRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Copies the invocation's cache config onto the request, together with the
   * newest cache metadata and prompt token count this agent produced earlier
   * in the session.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request object to populate in place.
   */
  // eslint-disable-next-line require-yield -- BaseLlmRequestProcessor mandates an AsyncGenerator, and this processor only mutates the request.
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agentName = requireAgent(invocationContext).name;

    if (!invocationContext.contextCacheConfig) {
      return;
    }

    llmRequest.cacheConfig = invocationContext.contextCacheConfig;

    const {cacheMetadata, previousTokenCount} = findCacheInfoFromEvents(
      invocationContext,
      agentName,
      invocationContext.invocationId,
    );

    if (cacheMetadata) {
      llmRequest.cacheMetadata = cacheMetadata;
      logger.debug(
        `Found cache metadata for agent ${agentName}:`,
        cacheMetadata,
      );
    }

    if (previousTokenCount !== undefined) {
      llmRequest.cacheableContentsTokenCount = previousTokenCount;
      logger.debug(
        `Found previous prompt token count for agent ${agentName}: ${previousTokenCount}`,
      );
    }

    logger.debug(`Context caching enabled for agent ${agentName}`);
  }
}

/**
 * Searches the session history newest-first for the cache state this agent
 * left behind.
 *
 * The two values are found independently, so an older event may supply the
 * token count for a cache found on a newer one. The pass stops as soon as both
 * are known.
 *
 * @param invocationContext - The context holding the session to search.
 * @param agentName - Only events authored by this agent are considered.
 * @param currentInvocationId - Decides whether the cache has survived into a
 *     new turn, and therefore whether its use counter advances.
 * @returns The newest cache metadata and prompt token count found.
 * @throws Error if an active cache from an earlier invocation has no use
 *     count.
 */
function findCacheInfoFromEvents(
  invocationContext: InvocationContext,
  agentName: string,
  currentInvocationId: string,
): CacheInfo {
  const events = invocationContext.session.events;
  let cacheMetadata: CacheMetadata | undefined;
  let previousTokenCount: number | undefined;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== agentName) {
      continue;
    }

    if (cacheMetadata === undefined && event.cacheMetadata !== undefined) {
      cacheMetadata = carryCacheMetadataForward(
        event.cacheMetadata,
        event.invocationId,
        currentInvocationId,
      );
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

/**
 * Copies an event's cache metadata for reuse on the next request.
 *
 * @param eventMetadata - The metadata stored on the session event.
 * @param eventInvocationId - The invocation that produced the event. An event
 *     that never reached a session carries the empty default, which counts as
 *     the same turn.
 * @param currentInvocationId - The invocation building the request.
 * @returns A copy of the metadata, with the use count advanced when an active
 *     cache crosses an invocation boundary.
 * @throws Error if such a cache has no use count.
 */
function carryCacheMetadataForward(
  eventMetadata: CacheMetadata,
  eventInvocationId: string,
  currentInvocationId: string,
): CacheMetadata {
  const servedAnotherInvocation =
    !!eventInvocationId &&
    eventInvocationId !== currentInvocationId &&
    eventMetadata.cacheName !== undefined;

  if (!servedAnotherInvocation) {
    return {...eventMetadata};
  }

  // Storage rehydrates an event without the factory, so the active-state
  // invariant createCacheMetadata enforces can still be broken here.
  if (eventMetadata.invocationsUsed === undefined) {
    throw new Error('Active cache metadata must include invocationsUsed.');
  }
  return {...eventMetadata, invocationsUsed: eventMetadata.invocationsUsed + 1};
}

export const CONTEXT_CACHE_REQUEST_PROCESSOR =
  new ContextCacheRequestProcessor();
