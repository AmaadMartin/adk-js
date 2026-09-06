/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {FunctionTool} from '../tools/function_tool.js';
import {BaseAgent} from './base_agent.js';
import {Context} from './context.js';
import {isLlmAgent, LlmAgent} from './llm_agent.js';

/** The name the model calls to hand off control to another agent. */
export const TRANSFER_TO_AGENT_TOOL_NAME = 'transfer_to_agent';

/**
 * The synthetic tool that performs an agent transfer.
 *
 * The framework synthesises it rather than the agent declaring it, so
 * `canonicalTools` never returns it. Any code that executes a transfer call has
 * to register it explicitly. Its declaration does not depend on the reachable
 * targets, so one instance serves every agent.
 */
export const TRANSFER_TO_AGENT_TOOL = new FunctionTool({
  name: TRANSFER_TO_AGENT_TOOL_NAME,
  description:
    'Transfer the question to another agent. This tool hands off control to another agent when it is more suitable to answer the user question according to the agent description.',
  parameters: z.object({
    agentName: z.string().describe('the agent name to transfer to.'),
  }),
  execute: function (args: {agentName: string}, toolContext?: Context) {
    if (!toolContext) {
      throw new Error('toolContext is required.');
    }
    toolContext.actions.transferToAgent = args.agentName;
    return 'Transfer queued';
  },
});

/**
 * The agents an `LlmAgent` may hand control to: its sub-agents, and — unless it
 * disallows them — its parent and the peers under that parent.
 *
 * A parent that is not an `LlmAgent` has no model to route with, so neither it
 * nor its other children are reachable.
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
