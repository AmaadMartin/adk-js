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
import {ReadonlyContext} from '../readonly_context.js';
import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './base_llm_processor.js';

/** The agent surface the planner resolver reads. */
interface AgentWithPlanner {
  planner?: unknown;
}

function hasPlanner(agent: object): agent is AgentWithPlanner {
  return 'planner' in agent;
}

/**
 * Resolves the planner that governs this invocation.
 *
 * The `planner` property is read structurally rather than through
 * {@link isLlmAgent}, because a flow can drive an agent that supplies the
 * `LlmAgent` surface without carrying its brand. A value that is not a
 * {@link BasePlanner} falls back to {@link PlanReActPlanner}, matching
 * adk-python.
 */
function getPlanner(
  invocationContext: InvocationContext,
): BasePlanner | undefined {
  const agent = requireAgent(invocationContext);
  if (!hasPlanner(agent) || !agent.planner) {
    return undefined;
  }
  return isBasePlanner(agent.planner) ? agent.planner : new PlanReActPlanner();
}

/** Clears the `thought` mark from every part of every content. */
function removeThoughtFromRequest(llmRequest: LlmRequest): void {
  for (const content of llmRequest.contents) {
    for (const part of content.parts ?? []) {
      part.thought = undefined;
    }
  }
}

/**
 * Applies the agent's planner to the outgoing {@link LlmRequest}.
 *
 * A {@link BuiltInPlanner} contributes only its thinking config and leaves the
 * contents alone, so a conversation that relies on native thinking keeps its
 * `thought` marks. Any other planner contributes a planning system instruction
 * and has the marks stripped, because the tags it reads back must not be
 * confused with the model's own thoughts.
 */
export class NlPlanningRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request to apply the planner to, mutated in place.
   */
  // eslint-disable-next-line require-yield -- BaseLlmRequestProcessor mandates an AsyncGenerator return type; this processor only mutates the request.
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const planner = getPlanner(invocationContext);
    if (!planner) {
      return;
    }

    if (isBuiltInPlanner(planner)) {
      planner.applyThinkingConfig(llmRequest);
      return;
    }

    const planningInstruction = await planner.buildPlanningInstruction({
      readonlyContext: new ReadonlyContext(invocationContext),
      llmRequest,
    });
    if (planningInstruction) {
      appendInstructions(llmRequest, [planningInstruction]);
    }
    removeThoughtFromRequest(llmRequest);
  }
}

/**
 * Hands the model's parts back to the agent's planner for post-processing.
 *
 * The planner may write session state while it splits the response, so the
 * processor emits a state-delta {@link Event} when it does.
 */
export class NlPlanningResponseProcessor extends BaseLlmResponseProcessor {
  /**
   * @param invocationContext - The current invocation context.
   * @param llmResponse - The response to post-process, mutated in place.
   */
  override async *runAsync(
    invocationContext: InvocationContext,
    llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    if (!llmResponse?.content?.parts?.length) {
      return;
    }

    const planner = getPlanner(invocationContext);
    // A planner that inherits the built-in no-op has nothing to do. The
    // identity comparison is what still lets an overriding subclass run.
    if (
      !planner ||
      planner.processPlanningResponse ===
        BuiltInPlanner.prototype.processPlanningResponse
    ) {
      return;
    }

    const context = new Context({invocationContext});
    const processedParts = await planner.processPlanningResponse({
      context,
      responseParts: llmResponse.content.parts,
    });
    if (processedParts?.length) {
      llmResponse.content.parts = processedParts;
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

export const NL_PLANNING_REQUEST_PROCESSOR = new NlPlanningRequestProcessor();

export const NL_PLANNING_RESPONSE_PROCESSOR = new NlPlanningResponseProcessor();
