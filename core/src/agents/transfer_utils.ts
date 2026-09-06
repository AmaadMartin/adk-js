/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from './base_agent.js';
import {InvocationContext, requireAgent} from './invocation_context.js';
import {isLlmAgent} from './llm_agent.js';

/**
 * Resolves the target of a `transfer_to_agent` call.
 *
 * The target name comes from the model, so it is validated here rather than
 * trusted: the agent must exist in the tree, and it must not be a peer of a
 * caller that sets `disallowTransferToPeers`.
 *
 * @param invocationContext The current invocation context.
 * @param agentName The model-supplied target agent name.
 * @returns The agent to run.
 * @throws Error if the name is unknown, or the transfer is disallowed.
 */
export function resolveTransferTarget(
  invocationContext: InvocationContext,
  agentName: string,
): BaseAgent {
  const caller = requireAgent(invocationContext);
  const target = caller.rootAgent.findAgent(agentName);
  if (!target) {
    throw new Error(`Agent ${agentName} not found in the agent tree.`);
  }
  if (
    isLlmAgent(caller) &&
    caller.disallowTransferToPeers &&
    target.parentAgent === caller.parentAgent &&
    target.name !== caller.name
  ) {
    throw new Error(`Transfer to sibling agent ${agentName} is disallowed.`);
  }
  return target;
}
