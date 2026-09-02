/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, isBaseAgent} from './base_agent.js';
import {isLlmAgent, LlmAgent} from './llm_agent.js';

/**
 * The agents an `LlmAgent` may hand control to.
 *
 * Sub-agents are always reachable. A parent and the peers under it are
 * reachable only when the agent does not disallow them, and only when the
 * parent is itself an `LlmAgent`: transfer is driven by the parent's model, so
 * a workflow or custom parent has nothing to route with.
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

/**
 * Whether any agent in the tree can hand control to another agent.
 *
 * Walks the whole tree rather than asking the root alone: a root that cannot
 * transfer may still coordinate sub-agents that can. Ported from
 * `google/adk-python` `runners.py::_can_transfer_between_agents`.
 *
 * @param root The root of the agent tree, or a bare node.
 * @returns True when at least one `LlmAgent` in the tree has a transfer target.
 */
export function canTransferBetweenAgents(root: unknown): boolean {
  if (!isBaseAgent(root)) {
    return false;
  }
  const pending: BaseAgent[] = [root];
  while (pending.length) {
    const agent = pending.pop()!;
    if (isLlmAgent(agent) && getTransferTargets(agent).length > 0) {
      return true;
    }
    pending.push(...agent.subAgents);
  }
  return false;
}
