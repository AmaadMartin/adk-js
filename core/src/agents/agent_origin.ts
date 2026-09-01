/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Where a root agent was loaded from, when a loader recorded it. */
export interface AgentOrigin {
  /** The app name implied by the directory the agent was loaded from. */
  appName?: string;
  /** Where the loader found the agent: its app directory, or its own file. */
  path?: string;
}

/**
 * Held beside the agent rather than on it, so recording where an agent came
 * from does not add properties to an object the caller owns. The entry lives
 * exactly as long as the agent does.
 */
const ORIGINS = new WeakMap<object, AgentOrigin>();

/**
 * Records where a loader found this agent, so a runner built around it can
 * report an app name that does not match the directory it came from.
 *
 * Mirrors adk-python's `_adk_origin_app_name` / `_adk_origin_path`.
 */
export function stampAgentOrigin(agent: object, origin: AgentOrigin): void {
  ORIGINS.set(agent, origin);
}

/**
 * Reads the origin metadata {@link stampAgentOrigin} recorded, or an empty
 * origin when nothing recorded any.
 *
 * adk-python falls back to a heuristic here, reading the agent class's module
 * file and walking it relative to the working directory. That has no
 * TypeScript counterpart — a class instance carries no module path — so only
 * the loader-supplied metadata is read.
 */
export function inferAgentOrigin(agent: object): AgentOrigin {
  return ORIGINS.get(agent) ?? {};
}
