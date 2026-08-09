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
 *
 * An event that carries no branch was authored at the root of the invocation
 * and stays visible from every branch, so it can be chained on while a branch
 * is active. This matches `_is_event_in_branch` in the adk-python reference
 * (`src/google/adk/flows/llm_flows/interactions_processor.py`).
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
        // Skip events not belonging to the current branch or author
        if (
          (!event.branch || event.branch === invocationContext.branch) &&
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
