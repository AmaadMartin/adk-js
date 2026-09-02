/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from './base_agent.js';
import {isLlmAgent, LlmAgent} from './llm_agent.js';

/** Agent modes that cannot service a conversation handed to them. */
export const NON_TRANSFERABLE_MODES: ReadonlyArray<LlmAgent['mode']> = [
  'single_turn',
  'task',
];

/**
 * Whether `agent` may be offered to the model as a transfer target.
 *
 * A `single_turn` or `task` agent is driven by the workflow graph rather than
 * by a transfer, so it is excluded. Only {@link LlmAgent} carries `mode`; every
 * other agent type is a valid target.
 */
export function isTransferTarget(agent: BaseAgent): boolean {
  return !isLlmAgent(agent) || !NON_TRANSFERABLE_MODES.includes(agent.mode);
}

/**
 * The agents an `LlmAgent` may hand control to.
 *
 * Sub-agents are reachable when {@link isTransferTarget} accepts them. A parent
 * and the peers under it are reachable only when the agent does not disallow
 * them, and only when the parent is itself an `LlmAgent`: transfer is driven by
 * the parent's model, so a workflow or custom parent has nothing to route with.
 * The parent is not filtered: returning control upwards is always allowed.
 */
export function getTransferTargets(agent: LlmAgent): BaseAgent[] {
  const targets: BaseAgent[] = agent.subAgents.filter(isTransferTarget);

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
          peerAgent.name !== agent.name && isTransferTarget(peerAgent),
      ),
    );
  }

  return targets;
}
