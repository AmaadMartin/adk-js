/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where a loader found a root agent.
 *
 * A runner compares this against its own `appName` and explains the mismatch
 * when a session lookup fails, because the two disagreeing is the usual reason
 * a session that exists cannot be found.
 */
export interface AgentOrigin {
  /** The app name implied by the directory the agent was loaded from. */
  appName?: string;
  /** The directory the loader found the agent in. */
  path?: string;
}

/**
 * Origins are held beside the agents rather than on them: recording where an
 * agent came from must not add fields to an object the caller owns.
 */
const AGENT_ORIGINS = new WeakMap<object, AgentOrigin>();

/**
 * Records where a loader found `agent`.
 *
 * Call this from a loader that knows the directory an agent was read from; see
 * `AgentLoader` in the `dev` package.
 */
export function stampAgentOrigin(agent: object, origin: AgentOrigin): void {
  AGENT_ORIGINS.set(agent, origin);
}

/**
 * Reads back the origin a loader stamped, or an empty origin.
 *
 * Only loader-supplied metadata is read. `adk-python` also falls back to a
 * heuristic over the agent class's module file, which a TypeScript class
 * instance does not carry, so a programmatically built agent has no origin
 * here. Mirrors `google/adk-python` `runners.py::Runner._infer_agent_origin`.
 */
export function inferAgentOrigin(agent: object): AgentOrigin {
  return AGENT_ORIGINS.get(agent) ?? {};
}
