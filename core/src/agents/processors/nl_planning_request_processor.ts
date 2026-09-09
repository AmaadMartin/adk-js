/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../../events/event.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {BasePlanner, isBasePlanner} from '../../planners/base_planner.js';
import {Context} from '../context.js';
import {InvocationContext, requireAgent} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './base_llm_processor.js';

/**
 * Appends the agent planner's instruction to the request, and clears the
 * thought markers the previous turns left on the request contents.
 */
export class NlPlanningRequestProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield -- the AsyncGenerator return type comes from BaseLlmRequestProcessor; this processor only mutates the request.
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const planner = getPlanner(invocationContext);
    if (!planner) {
      return;
    }

    const instruction = await planner.buildPlanningInstruction({
      readonlyContext: new ReadonlyContext(invocationContext),
      llmRequest,
    });
    if (instruction) {
      appendInstructions(llmRequest, [instruction]);
    }

    removeThoughtFromRequest(llmRequest);
  }
}

/**
 * Hands the model response parts to the agent planner, and emits the session
 * state the planner wrote.
 */
export class NlPlanningResponseProcessor extends BaseLlmResponseProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    const content = llmResponse.content;
    if (!content?.parts?.length) {
      return;
    }

    const planner = getPlanner(invocationContext);
    if (!planner) {
      return;
    }

    const context = new Context({invocationContext});
    const processedParts = await planner.processPlanningResponse({
      context,
      responseParts: content.parts,
    });
    if (processedParts) {
      content.parts = processedParts;
    }

    if (context.state.hasDelta()) {
      yield createEvent({
        invocationId: invocationContext.invocationId,
        author: requireAgent(invocationContext).name,
        branch: invocationContext.branch,
        actions: context.eventActions,
      });
    }
  }
}

/**
 * Returns the planner the invoked agent carries, if it carries one.
 *
 * A `planner` set from untyped JavaScript or from a config file can hold
 * anything, so the value is checked before it is called. adk-python falls back
 * to a default `PlanReActPlanner` here; adk-js has no such planner yet, so it
 * plans nothing instead.
 */
function getPlanner(
  invocationContext: InvocationContext,
): BasePlanner | undefined {
  const agent = invocationContext.agent;
  if (!isLlmAgent(agent) || !isBasePlanner(agent.planner)) {
    return undefined;
  }
  return agent.planner;
}

/**
 * Clears the thought marker on every part of the request, so the model is not
 * re-fed the reasoning a planner marked on an earlier turn.
 */
function removeThoughtFromRequest(llmRequest: LlmRequest): void {
  for (const content of llmRequest.contents) {
    for (const part of content.parts ?? []) {
      part.thought = undefined;
    }
  }
}

export const NL_PLANNING_REQUEST_PROCESSOR = new NlPlanningRequestProcessor();
export const NL_PLANNING_RESPONSE_PROCESSOR = new NlPlanningResponseProcessor();
