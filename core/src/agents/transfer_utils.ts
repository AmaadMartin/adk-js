/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from './base_agent.js';
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
