/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {RunnableRoot} from '../workflow/run_node_as_invocation.js';
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
 * Whether any agent in the tree rooted at `root` can transfer to another agent.
 *
 * A bare node is never transferable: transfer is a property of the agent tree,
 * and a workflow keeps its structure in edges instead. Ported from
 * `google/adk-python` `agents/_agent_router.py::can_transfer_between_agents`.
 */
export function canTransferBetweenAgents(root: RunnableRoot): boolean {
  if (!isBaseAgent(root)) {
    return false;
  }
  const pending: BaseAgent[] = [root];
  for (let i = 0; i < pending.length; i++) {
    const agent = pending[i];
    if (isLlmAgent(agent) && getTransferTargets(agent).length > 0) {
      return true;
    }
    pending.push(...agent.subAgents);
  }
  return false;
}
