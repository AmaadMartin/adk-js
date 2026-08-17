/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {
  TRANSFER_TO_AGENT_TOOL_NAME,
  TransferToAgentTool,
} from '../../tools/transfer_to_agent_tool.js';
import {BaseAgent} from '../base_agent.js';
import {Context} from '../context.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent, LlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Builds the transfer tool offering the given agents as targets.
 *
 * @param transferTargets - The agents that can be transferred to.
 * @returns A tool whose declaration accepts only those agent names.
 */
export function buildTransferTool(
  transferTargets: BaseAgent[],
): TransferToAgentTool {
  return new TransferToAgentTool(transferTargets.map((target) => target.name));
}

/**
 * Collects the agents the given agent may transfer to: its sub-agents, and —
 * unless disallowed — its parent agent and its peers.
 *
 * @param agent - The agent that would perform the transfer.
 * @returns The reachable transfer targets, empty when there are none.
 */
export function getTransferTargets(agent: LlmAgent): BaseAgent[] {
  const targets: BaseAgent[] = [];
  targets.push(...agent.subAgents);

  if (!agent.parentAgent || !isLlmAgent(agent.parentAgent)) {
    return targets;
  }

  if (!agent.disallowTransferToParent) {
    targets.push(agent.parentAgent);
  }

  if (!agent.disallowTransferToPeers) {
    targets.push(
      ...agent.parentAgent.subAgents.filter(
        (peerAgent) => peerAgent.name !== agent.name,
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

    appendInstructions(llmRequest, [
      this.buildTargetAgentsInstructions(
        invocationContext.agent,
        transferTargets,
      ),
    ]);

    const toolContext = new Context({invocationContext});
    await buildTransferTool(transferTargets).processLlmRequest({
      toolContext,
      llmRequest,
    });
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
    const availableAgentNames = targetAgents
      .map((targetAgent) => targetAgent.name)
      .sort()
      .map((name) => `\`${name}\``)
      .join(', ');

    let instructions = `
You have a list of other agents to transfer to:

${targetAgents.map((t) => this.buildTargetAgentsInfo(t)).join('\n')}

If you are the best to answer the question according to your description, you
can answer it.

If another agent is better for answering the question according to its
description, call \`${TRANSFER_TO_AGENT_TOOL_NAME}\` function to transfer the
question to that agent. When transferring, do not generate any text other than
the function call.

**NOTE**: the only available agents for \`${TRANSFER_TO_AGENT_TOOL_NAME}\` function are
${availableAgentNames}.
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
