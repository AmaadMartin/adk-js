/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '../../events/event.js';
import type {LlmRequest} from '../../models/llm_request.js';
import {appendInstructions} from '../../models/llm_request.js';
import {
  TRANSFER_TO_AGENT_TOOL_NAME,
  TransferToAgentTool,
} from '../../tools/transfer_to_agent_tool.js';
import type {BaseAgent} from '../base_agent.js';
import {Context} from '../context.js';
import type {InvocationContext} from '../invocation_context.js';
import type {LlmAgent} from '../llm_agent.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

export {
  TRANSFER_TO_AGENT_TOOL_NAME,
  TransferToAgentTool,
} from '../../tools/transfer_to_agent_tool.js';

/**
 * Builds the transfer tool for one agent, constrained to the names it may
 * transfer to.
 *
 * @param targets - The agents the model may transfer to.
 * @returns The tool that performs the hand-off.
 */
export function createTransferToAgentTool(
  targets: BaseAgent[],
): TransferToAgentTool {
  return new TransferToAgentTool({
    agentNames: targets.map((target) => target.name),
  });
}

/**
 * Whether the agent is a workflow node rather than a conversational agent.
 *
 * A `single_turn` or `task` agent runs once against the input the graph hands
 * it and then finishes, so it neither services a conversation handed to it nor
 * hands its own away. An agent with no mode — every non-LlmAgent, and every
 * conversational LlmAgent — is not a workflow node.
 *
 * @param agent - The agent to classify.
 * @returns True when the agent is a workflow node.
 */
function isWorkflowNodeAgent(agent: BaseAgent): boolean {
  return (
    isLlmAgent(agent) && (agent.mode === 'single_turn' || agent.mode === 'task')
  );
}

/**
 * Collects the agents the given agent may transfer to: its sub-agents, and —
 * unless disallowed — its parent agent and its peers. Workflow node agents are
 * never targets, because they run once against the input the graph hands them.
 *
 * @param agent - The agent that would perform the transfer.
 * @returns The reachable transfer targets, empty when there are none.
 */
export function getTransferTargets(agent: LlmAgent): BaseAgent[] {
  const targets: BaseAgent[] = [];
  targets.push(...agent.subAgents.filter((sub) => !isWorkflowNodeAgent(sub)));

  if (!agent.parentAgent || !isLlmAgent(agent.parentAgent)) {
    return targets;
  }

  if (!agent.disallowTransferToParent) {
    targets.push(agent.parentAgent);
  }

  if (!agent.disallowTransferToPeers) {
    targets.push(
      ...agent.parentAgent.subAgents.filter(
        (peerAgent) =>
          peerAgent.name !== agent.name && !isWorkflowNodeAgent(peerAgent),
      ),
    );
  }

  return targets;
}

/**
 * Augments the {@link LlmRequest} to support agent transfer. When the current
 * agent has reachable transfer targets (sub-agents, peer agents, or a parent
 * agent), this processor registers a `transfer_to_agent` function tool and
 * appends instructions describing each candidate so the model can choose to
 * hand off control.
 */
export class AgentTransferLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Appends transfer instructions and registers the `transfer_to_agent` tool
   * when the agent has reachable transfer targets.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request to augment with transfer instructions and the transfer tool.
   */
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    if (!isLlmAgent(invocationContext.agent)) {
      return;
    }

    const transferTargets = getTransferTargets(invocationContext.agent);
    if (!transferTargets.length) {
      return;
    }

    const instructions = this.buildTargetAgentsInstructions(
      invocationContext.agent,
      transferTargets,
    );
    if (instructions) {
      appendInstructions(llmRequest, [instructions]);
    }

    // The tool stays registered even for a workflow node agent, which gets no
    // instructions: adk-python registers it unconditionally, and the
    // confirmation-resume path re-injects it.
    const tool = createTransferToAgentTool(transferTargets);
    const toolContext = new Context({invocationContext});
    await tool.processLlmRequest({toolContext, llmRequest});
  }

  private buildTargetAgentsInfo(targetAgent: BaseAgent): string {
    return `
Agent name: ${targetAgent.name}
Agent description: ${targetAgent.description}
`;
  }

  private buildTargetAgentsInstructions(
    agent: LlmAgent,
    targetAgents: BaseAgent[],
  ): string {
    if (isWorkflowNodeAgent(agent)) {
      return '';
    }

    let instructions = `
You have a list of other agents to transfer to:

${targetAgents.map((t) => this.buildTargetAgentsInfo(t)).join('\n')}

If you are the best to answer the question according to your description, you
can answer it.

If another agent is better for answering the question according to its
description, call \`${TRANSFER_TO_AGENT_TOOL_NAME}\` function to transfer the
question to that agent. When transferring, do not generate any text other than
the function call.
`;

    if (agent.parentAgent && !agent.disallowTransferToParent) {
      instructions += `
Your parent agent is ${agent.parentAgent.name}. If neither the other agents nor
you are best for answering the question according to the descriptions, transfer
to your parent agent.
`;
    }
    return instructions;
  }
}

export const AGENT_TRANSFER_LLM_REQUEST_PROCESSOR =
  new AgentTransferLlmRequestProcessor();
