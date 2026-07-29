/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {CacheMetadata} from '../../models/cache_metadata.js';
import {LlmRequest} from '../../models/llm_request.js';
import {logger} from '../../utils/logger.js';
import {InvocationContext} from '../invocation_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Cache information recovered from the events already stored on the session.
 */
interface CacheInfo {
  /**
   * Metadata of the most recent cache produced by this agent, with
   * `invocationsUsed` advanced when the cache is being reused in a new
   * invocation.
   */
  cacheMetadata?: CacheMetadata;

  /**
   * Prompt token count reported by this agent's most recent response, used to
   * decide whether the request is large enough to be worth caching.
   */
  previousTokenCount?: number;
}

/**
 * Scans the session backwards for the newest cache metadata and prompt token
 * count produced by the agent that owns `invocationContext`.
 *
 * @param invocationContext The current invocation context.
 * @returns The recovered {@link CacheInfo}; fields are undefined when the
 *     session holds nothing usable.
 */
function findCacheInfoFromEvents(
  invocationContext: InvocationContext,
): CacheInfo {
  const agentName = invocationContext.agent.name;
  const currentInvocationId = invocationContext.invocationId;
  const events = invocationContext.session?.events;
  if (!events || events.length === 0) {
    return {};
  }

  const info: CacheInfo = {};

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== agentName) {
      continue;
    }

    if (info.cacheMetadata === undefined && event.cacheMetadata !== undefined) {
      if (
        event.invocationId &&
        event.invocationId !== currentInvocationId &&
        event.cacheMetadata.cacheName !== undefined
      ) {
        // An active cache (cacheName set) always carries invocationsUsed:
        // createCacheMetadata rejects any other combination.
        info.cacheMetadata = {
          ...event.cacheMetadata,
          invocationsUsed: event.cacheMetadata.invocationsUsed! + 1,
        };
      } else {
        info.cacheMetadata = {...event.cacheMetadata};
      }
    }

    if (
      info.previousTokenCount === undefined &&
      event.usageMetadata?.promptTokenCount !== undefined
    ) {
      info.previousTokenCount = event.usageMetadata.promptTokenCount;
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
 * Request processor that enables context caching for LLM requests.
 *
 * This processor sets up context caching configuration for agents that have
 * context caching enabled and finds the latest cache metadata from session
 * events.
 */
export class ContextCacheRequestProcessor implements BaseLlmRequestProcessor {
  /**
   * Applies the agent's context cache configuration to the outgoing request.
   *
   * @param invocationContext The current invocation context.
   * @param llmRequest The request to populate, mutated in place.
   */
  // eslint-disable-next-line require-yield -- BaseLlmRequestProcessor.runAsync is an AsyncGenerator so processors may emit events; this one only mutates llmRequest and has nothing to emit.
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const cacheConfig = invocationContext.contextCacheConfig;
    if (!cacheConfig) {
      return;
    }

    llmRequest.cacheConfig = cacheConfig;

    const {cacheMetadata, previousTokenCount} =
      findCacheInfoFromEvents(invocationContext);

    if (cacheMetadata) {
      llmRequest.cacheMetadata = cacheMetadata;
      logger.debug(
        `Found cache metadata for agent ${invocationContext.agent.name}: ${JSON.stringify(cacheMetadata)}`,
      );
    }

    if (previousTokenCount !== undefined) {
      llmRequest.cacheableContentsTokenCount = previousTokenCount;
      logger.debug(
        `Found previous prompt token count for agent ${invocationContext.agent.name}: ${previousTokenCount}`,
      );
    }

    logger.debug(
      `Context caching enabled for agent ${invocationContext.agent.name}`,
    );
  }
}

export const CONTEXT_CACHE_REQUEST_PROCESSOR =
  new ContextCacheRequestProcessor();
