/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getActiveEvents,
  recoverCompactedFunctionCalls,
} from '../../context/compaction_utils.js';
import {Event} from '../../events/event.js';
import {
  insertTransientUserContent,
  LlmRequest,
} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';
import {
  getContents,
  GetContentsOptions,
  getCurrentTurnContents,
  insertModelInputContext,
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
    const model = agent.canonicalModel;
    const options: GetContentsOptions = {
      preserveFunctionCallIds: model.pairsToolCallsById,
      isSingleTurn: agent.mode === 'single_turn',
      userContent: invocationContext.userContent,
    };

    // Contents an earlier processor put on the request — a static instruction,
    // the dynamic instruction that rides behind it — would be lost by the
    // reassignment below.
    const instructionContents = llmRequest.contents;

    if (
      agent.includeContents === 'default' &&
      !llmRequest.previousInteractionId
    ) {
      // Include full conversation history
      llmRequest.contents = getContents(
        events,
        agent.name,
        invocationContext.branch,
        invocationContext.isolationScope,
        {
          ...options,
          includeThoughtsFromOtherAgents:
            invocationContext.runConfig?.includeThoughtsFromOtherAgents ??
            false,
        },
      );
    } else {
      // Include current turn context only (no conversation history). Another
      // agent's thoughts are history, so they stay out of a current-turn build.
      // A request that carries a previous interaction id is a chained
      // Interactions request, and the service already retains the earlier
      // turns.
      llmRequest.contents = getCurrentTurnContents(
        events,
        agent.name,
        invocationContext.branch,
        invocationContext.isolationScope,
        {...options, includeThoughtsFromOtherAgents: false},
      );
    }

    const modelInputContext = invocationContext.runConfig?.modelInputContext;
    if (modelInputContext) {
      insertModelInputContext(
        llmRequest.contents,
        modelInputContext,
        invocationContext.userContent,
      );
    }

    insertTransientUserContent(llmRequest, instructionContents);

    return;
  }
}

export const CONTENT_REQUEST_PROCESSOR = new ContentRequestProcessor();
