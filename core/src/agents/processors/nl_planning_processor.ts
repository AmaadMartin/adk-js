/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '../../events/event.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {BasePlanner, isBasePlanner} from '../../planners/base_planner.js';
import {
  BuiltInPlanner,
  isBuiltInPlanner,
} from '../../planners/built_in_planner.js';
import {PlanReActPlanner} from '../../planners/plan_re_act_planner.js';
import {Context} from '../context.js';
import {InvocationContext, requireAgent} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';

import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './base_llm_processor.js';

/**
 * Resolves the planner the current agent runs with.
 *
 * An agent carrying a planner that is not an ADK planner falls back to the
 * default {@link PlanReActPlanner}, matching adk-python.
 */
function getPlanner(
  invocationContext: InvocationContext,
): BasePlanner | undefined {
  const agent = requireAgent(invocationContext);
  if (!isLlmAgent(agent) || !agent.planner) {
    return undefined;
  }
  return isBasePlanner(agent.planner) ? agent.planner : new PlanReActPlanner();
}

/**
 * Clears the thought flag from every part of the request.
 *
 * A previous turn's reasoning must not be re-sent to the model as a thought.
 */
function removeThoughtFromRequest(llmRequest: LlmRequest): void {
  for (const content of llmRequest.contents) {
    for (const part of content.parts ?? []) {
      part.thought = undefined;
    }
  }
}

/**
 * Applies the agent's planner to the {@link LlmRequest}.
 *
 * A {@link BuiltInPlanner} contributes its thinking config and nothing else.
 * Any other planner contributes a planning system instruction, and its
 * request contents lose their thought flags.
 */
export class NlPlanningRequestProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield -- the AsyncGenerator signature comes from BaseLlmRequestProcessor; this processor only mutates the request.
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, undefined> {
    const planner = getPlanner(invocationContext);
    if (!planner) {
      return;
    }

    if (isBuiltInPlanner(planner)) {
      planner.applyThinkingConfig(llmRequest);
      return;
    }

    const planningInstruction = planner.buildPlanningInstruction(
      new ReadonlyContext(invocationContext),
      llmRequest,
    );
    if (planningInstruction) {
      appendInstructions(llmRequest, [planningInstruction]);
    }
    removeThoughtFromRequest(llmRequest);
  }
}

/** The request processor instance registered by {@link LlmAgent}. */
export const NL_PLANNING_REQUEST_PROCESSOR = new NlPlanningRequestProcessor();

/**
 * Hands the model's response parts to the agent's planner for
 * post-processing, and emits the state delta the planner wrote, if any.
 */
export class NlPlanningResponseProcessor extends BaseLlmResponseProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, undefined> {
    if (!llmResponse?.content?.parts?.length) {
      return;
    }

    const planner = getPlanner(invocationContext);
    // A planner that inherits BuiltInPlanner's no-op has nothing to do. The
    // method identity comparison mirrors adk-python, so a subclass that
    // overrides the method still runs.
    if (
      !planner ||
      planner.processPlanningResponse ===
        BuiltInPlanner.prototype.processPlanningResponse
    ) {
      return;
    }

    const callbackContext = new Context({invocationContext});
    const processedParts = planner.processPlanningResponse(
      callbackContext,
      llmResponse.content.parts,
    );
    if (processedParts?.length) {
      llmResponse.content.parts = processedParts;
    }

    if (callbackContext.state.hasDelta()) {
      yield createEvent({
        invocationId: invocationContext.invocationId,
        author: requireAgent(invocationContext).name,
        branch: invocationContext.branch,
        actions: callbackContext.eventActions,
      });
    }
  }
}

/** The response processor instance registered by {@link LlmAgent}. */
export const NL_PLANNING_RESPONSE_PROCESSOR = new NlPlanningResponseProcessor();
