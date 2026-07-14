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
 * Request processor that enables context caching for LLM requests.
 *
 * This processor sets up context caching configuration for agents that have
 * context caching enabled and finds the latest cache metadata from session
 * events.
 */
export class ContextCacheRequestProcessor implements BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const cacheConfig = invocationContext.contextCacheConfig;
    if (!cacheConfig) {
      return;
    }

    llmRequest.cacheConfig = cacheConfig;

    const [latestCacheMetadata, previousTokenCount] =
      this.findCacheInfoFromEvents(
        invocationContext,
        invocationContext.agent.name,
        invocationContext.invocationId,
      );

    if (latestCacheMetadata) {
      llmRequest.cacheMetadata = latestCacheMetadata;
      logger.debug(
        `Found cache metadata for agent ${invocationContext.agent.name}: ${JSON.stringify(latestCacheMetadata)}`,
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

  private findCacheInfoFromEvents(
    invocationContext: InvocationContext,
    agentName: string,
    currentInvocationId: string,
  ): [CacheMetadata | undefined, number | undefined] {
    const events = invocationContext.session?.events;
    if (!events || events.length === 0) {
      return [undefined, undefined];
    }

    let cacheMetadata: CacheMetadata | undefined;
    let previousTokenCount: number | undefined;

    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.author !== agentName) {
        continue;
      }

      if (cacheMetadata === undefined && event.cacheMetadata !== undefined) {
        if (
          event.invocationId &&
          event.invocationId !== currentInvocationId &&
          event.cacheMetadata.cacheName !== undefined
        ) {
          cacheMetadata = {
            ...event.cacheMetadata,
            invocationsUsed: (event.cacheMetadata.invocationsUsed ?? 0) + 1,
          };
        } else {
          cacheMetadata = {...event.cacheMetadata};
        }
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

    return [cacheMetadata, previousTokenCount];
  }
}

export const CONTEXT_CACHE_REQUEST_PROCESSOR =
  new ContextCacheRequestProcessor();
