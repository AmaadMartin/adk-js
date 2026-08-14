/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, RunnableRoot} from '@google/adk';

/** One entry of a detailed agent listing. */
export interface AgentInfo {
  name: string;
  displayName?: string;
  description?: string;
  type?: string;
}

/**
 * The agent source the dev API server reads from.
 *
 * Extend this to serve agents that do not live in a directory of files, such
 * as a database, a registry or an in-process map, and pass the subclass as the
 * `agentLoader` option of `AdkApiServer`.
 */
export abstract class BaseAgentLoader {
  /** Lists available agent names, in alphabetical order. */
  abstract listAgents(): Promise<string[]>;

  /** Loads the agent (or app) served under `agentName`. */
  abstract loadAgent(agentName: string): Promise<RunnableRoot | App>;

  /**
   * Names only, for a loader that cannot describe an agent without loading it.
   * Override when richer metadata is available cheaply.
   */
  async listAgentsDetailed(): Promise<AgentInfo[]> {
    const names = await this.listAgents();

    return names.map((name) => ({name}));
  }
}
