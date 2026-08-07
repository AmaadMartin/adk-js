/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {isGemini} from '../../models/google_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Request processor for Gemini Interactions API.
 * Resolves the previous interaction ID from the session history.
 */
export class InteractionsRequestProcessor implements BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!agent || !isLlmAgent(agent)) {
      return;
    }

    const model = agent.canonicalModel;
    if (isGemini(model) && model.useInteractionsApi) {
      const events = invocationContext.session.events;
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        // The interactionId check is not redundant: a branch/author match
        // without an id is skipped so the scan continues to an older event
        // that has one.
        if (
          event.branch === invocationContext.branch &&
          event.author === agent.name &&
          event.interactionId
        ) {
          llmRequest.previousInteractionId = event.interactionId;
          break;
        }
      }
    }
  }
}

export const INTERACTIONS_REQUEST_PROCESSOR =
  new InteractionsRequestProcessor();
