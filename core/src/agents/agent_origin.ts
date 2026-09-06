/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseAgent} from './base_agent.js';

/**
 * Where an agent was loaded from, used to sanity-check a runner's app name.
 *
 * Ported from `google/adk-python`, whose `AgentLoader` stamps
 * `_adk_origin_app_name` and `_adk_origin_path` on the agent it loads and
 * whose `Runner` reads them back.
 */
export interface AgentOrigin {
  /** The app name implied by the agent's location, its directory name. */
  appName?: string;
  /** The directory the agent was loaded from. */
  dir?: string;
}

/**
 * The origin of each stamped agent.
 *
 * A `WeakMap` rather than a field on `BaseAgent`: the origin is loader
 * metadata, not part of an agent's declared surface, so it stays off the
 * serialized config shape and out of anything that walks an agent's own
 * properties.
 */
const agentOrigins = new WeakMap<BaseAgent, AgentOrigin>();

/**
 * Records where a loader found this agent.
 *
 * @param agent The agent the loader produced.
 * @param origin Where it was loaded from.
 */
export function setAgentOrigin(agent: BaseAgent, origin: AgentOrigin): void {
  agentOrigins.set(agent, origin);
}

/**
 * Returns where a loader found this agent.
 *
 * @param agent The agent to look up.
 * @returns The recorded origin, or `undefined` for an agent no loader stamped,
 *     such as one a user constructed directly.
 */
export function getAgentOrigin(agent: BaseAgent): AgentOrigin | undefined {
  return agentOrigins.get(agent);
}
