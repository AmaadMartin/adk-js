/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getActiveEvents} from '../../context/compaction_utils.js';
import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent, LlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';
import {
  getContents,
  GetContentsOptions,
  getCurrentTurnContents,
  recoverCompactedFunctionCalls,
} from './content_processor_utils.js';

/**
 * Populates {@link LlmRequest.contents} from the session event history.
 *
 * When a {@link CompactedEvent} exists in the session, only the most recent
 * compacted event and the raw events that follow it are included, eliding
 * earlier history. The extent of context included depends on the agent's
 * `includeContents` setting: `'default'` sends the full visible history while
 * any other value sends only the current-turn context.
 */
export class ContentRequestProcessor implements BaseLlmRequestProcessor {
  /**
   * Fills {@link LlmRequest.contents} based on the session event history and
   * agent configuration.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request whose contents field will be populated.
   */
  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!agent || !isLlmAgent(agent)) {
      return;
    }

    const allEvents = invocationContext.session.events;
    const events = recoverCompactedFunctionCalls(
      getActiveEvents(allEvents),
      allEvents,
    );
    const options: GetContentsOptions = {
      preserveFunctionCallIds: pairsToolCallsById(agent),
    };

    if (agent.includeContents === 'default') {
      // Include full conversation history
      llmRequest.contents = getContents(
        events,
        agent.name,
        invocationContext.branch,
        invocationContext.isolationScope,
        options,
      );
    } else {
      // Include current turn context only (no conversation history).
      llmRequest.contents = getCurrentTurnContents(
        events,
        agent.name,
        invocationContext.branch,
        invocationContext.isolationScope,
        options,
      );
    }

    return;
  }
}

/**
 * Whether the agent's model pairs a tool call with its result by id.
 *
 * Resolving the model can throw: the agent may have no model anywhere in its
 * ancestry, or the provider may reject the credentials it was given. Neither is
 * this processor's error to raise — the flow reports it when it calls the
 * model. Fall back to stripping the ids, which is what Gemini
 * `generateContent`, the default protocol, requires. Mirrors the
 * `hasattr(agent, 'canonical_model')` guard in
 * `src/google/adk/flows/llm_flows/contents.py`.
 */
function pairsToolCallsById(agent: LlmAgent): boolean {
  try {
    return agent.canonicalModel.pairsToolCallsById;
  } catch {
    return false;
  }
}

export const CONTENT_REQUEST_PROCESSOR = new ContentRequestProcessor();
