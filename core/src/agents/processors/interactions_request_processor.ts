/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {Gemini} from '../../models/google_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

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
    if (!(model instanceof Gemini) || !model.useInteractionsApi) {
      return;
    }

    const events = invocationContext.session.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (
        event.branch === invocationContext.branch &&
        event.author === agent.name &&
        event.interactionId
      ) {
        llmRequest.previousInteractionId = event.interactionId;
        break;
      }
    }

    return;
  }
}

export const INTERACTIONS_REQUEST_PROCESSOR =
  new InteractionsRequestProcessor();
