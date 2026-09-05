/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext, requireAgent} from '../invocation_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Returns the agent's most recent prompt token count, or undefined when the
 * agent has not answered in this session yet.
 *
 * The count gates the minimum request size worth caching. Only this agent's
 * own turns are measured, because a sibling's prompt says nothing about the
 * size of this one.
 */
function latestPromptTokenCount(
  events: Event[],
  agentName: string,
): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== agentName) {
      continue;
    }
    const promptTokenCount = event.usageMetadata?.promptTokenCount;
    if (promptTokenCount !== undefined) {
      return promptTokenCount;
    }
  }
  return undefined;
}

/**
 * Stages context caching for the request.
 *
 * It publishes the app's cache configuration on the request, and hands the
 * model layer the previous turn's prompt token count, which is what decides
 * whether the request is large enough to be worth caching. Marking the prefix,
 * and reusing or expiring the cache, belongs to the model layer.
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
    llmRequest.cacheableContentsTokenCount = latestPromptTokenCount(
      invocationContext.session.events,
      requireAgent(invocationContext).name,
    );
  }
}

/** The shared context cache request processor. */
export const CONTEXT_CACHE_REQUEST_PROCESSOR =
  new ContextCacheRequestProcessor();
