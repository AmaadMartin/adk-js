/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RemoteA2AAgent} from '@google/adk';

const PORT_ENV_VAR = 'TEST_API_SERVER_PORT';

/**
 * Returns the port of the test ADK API server this agent is loaded into.
 *
 * The harness picks that port at random and this agent points back at its own
 * server, so no default could ever be right.
 *
 * @throws If the environment variable is unset or not a positive integer.
 */
function requireServerPort(): number {
  const raw = process.env[PORT_ENV_VAR];
  if (!raw) {
    throw new Error(
      `${PORT_ENV_VAR} is not set. This agent points back at the test ADK ` +
        `API server it runs inside, so it has no default port to fall back ` +
        `to; AdkTsApiServer must propagate ${PORT_ENV_VAR}.`,
    );
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `${PORT_ENV_VAR} must be a positive integer, got "${raw}".`,
    );
  }

  return port;
}

const port = requireServerPort();

export const rootAgent = new RemoteA2AAgent({
  name: 'multi_hop',
  agentCard: `http://localhost:${port}/a2a/multi_hop/`,
});
