/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, RunnableRoot} from '@google/adk';

/**
 * Contract for classes that discover agents and turn them into runnable roots.
 *
 * Mirrors adk-python's `cli/utils/base_agent_loader.BaseAgentLoader`. The
 * methods return promises here because every adk-js loader reads from disk,
 * while the Python contract is synchronous.
 */
export interface BaseAgentLoader {
  /** Loads the agent registered under `agentName`. */
  loadAgent(agentName: string): Promise<RunnableRoot | App>;

  /** Lists the available agent names in alphabetical order. */
  listAgents(): Promise<string[]>;
}

/**
 * A loaded agent file, held for as long as its agent is in use and released
 * on disposal.
 */
export interface LoadedAgentFile extends AsyncDisposable {
  /** Returns the agent the file exports, compiling it on the first call. */
  load(): Promise<RunnableRoot | App>;
}

/**
 * The loader surface the ADK API server drives.
 *
 * `AgentLoader` satisfies it. It is named separately so a caller can serve
 * from a loader of its own without subclassing a class whose private fields
 * make a structural stand-in impossible.
 */
export interface ServerAgentLoader extends BaseAgentLoader {
  /** Returns the file `agentName` loads from, for a caller that disposes it. */
  getAgentFile(agentName: string): Promise<LoadedAgentFile>;
}
