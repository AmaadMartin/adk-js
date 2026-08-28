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
  /**
   * Lists the available agent names, in alphabetical order.
   *
   * The server does not sort the result: this is the order `/list-apps`
   * reports.
   */
  listAgents(): Promise<string[]>;

  /**
   * Loads the agent (or app) served under `agentName`.
   *
   * Let failures propagate. The server answers 500 with the message this
   * rejects with, so catching and re-messaging hides the cause from the
   * caller.
   *
   * The server calls this on every request that needs the agent, and disposes
   * nothing it returns. Cache and release inside the loader when construction
   * allocates, as `AgentLoader` does.
   */
  loadAgent(agentName: string): Promise<RunnableRoot | App>;
}
