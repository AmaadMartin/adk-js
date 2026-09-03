/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, RunnableRoot} from '@google/adk';

/**
 * One agent as reported by {@link BaseAgentLoader.listAgentsDetailed}.
 *
 * A loader that knows only the names leaves every other field `null`, so a
 * caller can render a list without asking each loader for metadata it may not
 * hold.
 */
export interface AgentInfo {
  name: string;
  displayName: string | null;
  description: string | null;
  type: string | null;
}

/**
 * Contract for classes that discover agents and turn them into runnable roots.
 *
 * Mirrors adk-python's `cli/utils/base_agent_loader.BaseAgentLoader`. The
 * methods return promises here because every adk-js loader reads from disk,
 * while the Python contract is synchronous.
 */
export abstract class BaseAgentLoader {
  /** Loads the agent registered under `agentName`. */
  abstract loadAgent(agentName: string): Promise<RunnableRoot | App>;

  /** Lists the available agent names in alphabetical order. */
  abstract listAgents(): Promise<string[]>;

  /**
   * Lists the available agents with their metadata.
   *
   * A loader that holds richer metadata overrides this.
   */
  async listAgentsDetailed(): Promise<AgentInfo[]> {
    const agentNames = await this.listAgents();
    return agentNames.map((name) => ({
      name,
      displayName: null,
      description: null,
      type: null,
    }));
  }
}
