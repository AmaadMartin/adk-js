/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {isGemini} from '../../models/google_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {isEventInBranch} from '../../utils/branch_trie.js';
import {logger} from '../../utils/logger.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/** The interaction ids carried by the most recent matching event. */
export interface PreviousInteractionState {
  interactionId?: string;
  environmentId?: string;
}

/**
 * Finds the interaction ids of the most recent event authored by `agentName`.
 *
 * Scans `events` in reverse, skips events outside `currentBranch`, and returns
 * the ids from the first event that this agent authored and that carries an
 * interaction id. Both ids are absent when no event matches.
 */
export function findPreviousInteractionState(
  events: Event[],
  agentName: string,
  currentBranch?: string,
): PreviousInteractionState {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!isEventInBranch(currentBranch, event)) {
      continue;
    }
    if (event.author === agentName && event.interactionId) {
      logger.debug(
        `Found interaction_id from agent ${agentName}: ${event.interactionId}`,
      );
      return {
        interactionId: event.interactionId,
        environmentId: event.environmentId,
      };
    }
  }
  return {};
}

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
      const {interactionId} = findPreviousInteractionState(
        invocationContext.session.events,
        agent.name,
        invocationContext.branch,
      );
      if (interactionId) {
        llmRequest.previousInteractionId = interactionId;
      }
    }
  }
}

export const INTERACTIONS_REQUEST_PROCESSOR =
  new InteractionsRequestProcessor();
