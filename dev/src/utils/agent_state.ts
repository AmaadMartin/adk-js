/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, isBaseAgent, isLlmAgent, RunnableRoot} from '@google/adk';

/** Matches a `{key}` placeholder an instruction reads out of session state. */
const STATE_PLACEHOLDER_PATTERN = /{(\w+)}/g;

/**
 * Collects the session-state keys an agent tree reads, each mapped to an
 * empty string.
 *
 * An instruction written as `Greet {user_name}` reads `user_name` out of the
 * session state. Seeding the key tells whoever fills the state in -- the eval
 * UI, most usefully -- which keys the agent expects, instead of leaving them
 * to be discovered from a failed run. A port of adk-python's
 * `cli/utils/state.create_empty_state`.
 *
 * Only a string instruction is scanned. An instruction supplied by a function
 * is built per invocation and has no keys to read here. A `Workflow` root has
 * no instruction of its own and yields no keys.
 *
 * @param root The agent whose tree to walk.
 */
export function createEmptyState(root: RunnableRoot): Record<string, string> {
  const state: Record<string, string> = {};
  if (isBaseAgent(root)) {
    collectStateKeys(root, state, new Set<BaseAgent>());
  }
  return state;
}

/** Walks the agent tree once, guarding against a cycle between agents. */
function collectStateKeys(
  agent: BaseAgent,
  state: Record<string, string>,
  visited: Set<BaseAgent>,
): void {
  if (visited.has(agent)) {
    return;
  }
  visited.add(agent);

  for (const subAgent of agent.subAgents) {
    if (isBaseAgent(subAgent)) {
      collectStateKeys(subAgent, state, visited);
    }
  }

  if (!isLlmAgent(agent) || typeof agent.instruction !== 'string') {
    return;
  }
  for (const match of agent.instruction.matchAll(STATE_PLACEHOLDER_PATTERN)) {
    state[match[1]] = '';
  }
}
