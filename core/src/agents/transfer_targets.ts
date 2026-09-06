/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from './base_agent.js';
import {isLlmAgent, LlmAgent} from './llm_agent.js';

/**
 * The agents `agent` can hand control to: its sub-agents, its parent unless
 * transfer to the parent is disallowed, and its peers unless transfer to peers
 * is disallowed.
 *
 * Ported from adk-python's `agent_transfer._get_transfer_targets`. The agent
 * transfer request processor offers exactly these agents to the model, and
 * `LlmAgent.canonicalTools` uses the same list to decide whether the model will
 * see more than one tool.
 *
 * @param agent The agent to find transfer targets for.
 * @returns The reachable agents, empty when transfer is fully disabled.
 */
export function getTransferTargets(agent: LlmAgent): BaseAgent[] {
  const targets: BaseAgent[] = [...agent.subAgents];

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
