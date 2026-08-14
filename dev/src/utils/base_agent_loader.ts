/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, RunnableRoot} from '@google/adk';

/**
 * The agent source the dev API server reads from.
 *
 * Implement this to serve agents that do not live in a directory of files,
 * such as a database, a registry or an in-process map, and pass the
 * implementation as the `agentLoader` option of `AdkApiServer`.
 */
export interface BaseAgentLoader {
  /** Lists available agent names, in alphabetical order. */
  listAgents(): Promise<string[]>;

  /** Loads the agent (or app) served under `agentName`. */
  loadAgent(agentName: string): Promise<RunnableRoot | App>;
}
