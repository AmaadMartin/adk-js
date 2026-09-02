/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {LlmRequest, appendInstructions} from '../../models/llm_request.js';
import {InvocationContext, requireAgent} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Appends identity instructions to the {@link LlmRequest} system prompt,
 * informing the model of the agent's name and description.
 *
 * An agent in `single_turn` mode gets no identity instruction.
 */
export class IdentityLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Appends the agent name and description as one identity instruction to the
   * system prompt of the request, unless the agent runs in `single_turn` mode.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request object to append instructions to.
   */
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, undefined> {
    const agent = requireAgent(invocationContext);
    if (isLlmAgent(agent) && agent.mode === 'single_turn') {
      return;
    }
    let si = `You are an agent. Your internal name is "${agent.name}".`;
    if (agent.description) {
      si += ` The description about you is "${agent.description}".`;
    }
    appendInstructions(llmRequest, [si]);
  }
}

export const IDENTITY_LLM_REQUEST_PROCESSOR = new IdentityLlmRequestProcessor();
