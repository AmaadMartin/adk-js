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
