/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {RunnableRoot} from '../workflow/run_node_as_invocation.js';
import {BaseAgent, isBaseAgent} from './base_agent.js';
import {isLlmAgent, LlmAgent} from './llm_agent.js';

/**
 * The agents `agent` may transfer to.
 *
 * Its sub-agents are always reachable. Its parent and its peers are reachable
 * too, unless the agent opts out with `disallowTransferToParent` or
 * `disallowTransferToPeers`. A parent that is not an `LlmAgent` contributes
 * nothing: it has no transfer tool to be reached through.
 */
export function getTransferTargets(agent: LlmAgent): BaseAgent[] {
  const targets: BaseAgent[] = [...agent.subAgents];

  const parent = agent.parentAgent;
  if (!parent || !isLlmAgent(parent)) {
    return targets;
  }

  if (!agent.disallowTransferToParent) {
    targets.push(parent);
  }

  if (!agent.disallowTransferToPeers) {
    targets.push(
      ...parent.subAgents.filter((peer) => peer.name !== agent.name),
    );
  }

  return targets;
}

/**
 * Whether any agent in the tree rooted at `root` can transfer to another agent.
 *
 * Mirrors adk-python `agents/_agent_router.py::can_transfer_between_agents`.
 */
export function canTransferBetweenAgents(root: RunnableRoot): boolean {
  const pending: BaseAgent[] = isBaseAgent(root) ? [root] : [];
  while (pending.length) {
    const agent = pending.pop()!;
    if (isLlmAgent(agent) && getTransferTargets(agent).length > 0) {
      return true;
    }
    pending.push(...agent.subAgents);
  }
  return false;
}
