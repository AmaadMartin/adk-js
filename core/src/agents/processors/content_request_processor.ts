/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {cloneDeep, isEqual} from 'lodash-es';

import {getActiveEvents} from '../../context/compaction_utils.js';
import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';
import {
  getContents,
  getCurrentTurnContents,
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

    const events = getActiveEvents(invocationContext.session.events);

    if (agent.includeContents === 'default') {
      // Include full conversation history
      llmRequest.contents = getContents(
        events,
        agent.name,
        invocationContext.branch,
        invocationContext.isolationScope,
      );
    } else {
      // Include current turn context only (no conversation history).
      llmRequest.contents = getCurrentTurnContents(
        events,
        agent.name,
        invocationContext.branch,
        invocationContext.isolationScope,
      );
    }

    addModelInputContextToUserContent(
      llmRequest,
      invocationContext.userContent,
      invocationContext.runConfig?.modelInputContext,
    );

    return;
  }
}

/**
 * Inserts the run's transient context immediately before the user's message.
 *
 * The request holds a deep copy, so the caller's array is never aliased into
 * it, and nothing here reaches the session. Without a matching user message the
 * context goes to the front of the request.
 */
function addModelInputContextToUserContent(
  llmRequest: LlmRequest,
  userContent: Content | undefined,
  modelInputContext: Content[] | undefined,
): void {
  if (!modelInputContext?.length) {
    return;
  }

  let insertIndex = 0;
  if (userContent) {
    for (let i = llmRequest.contents.length - 1; i >= 0; i--) {
      if (isEqual(llmRequest.contents[i], userContent)) {
        insertIndex = i;
        break;
      }
    }
  }

  llmRequest.contents.splice(insertIndex, 0, ...cloneDeep(modelInputContext));
}

export const CONTENT_REQUEST_PROCESSOR = new ContentRequestProcessor();
