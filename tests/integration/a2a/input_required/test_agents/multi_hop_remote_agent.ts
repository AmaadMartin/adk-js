/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RemoteA2AAgent} from '@google/adk';

const PORT_ENV_VAR = 'TEST_API_SERVER_PORT';

/**
 * Returns the port of the test ADK API server that hosts this agent.
 *
 * This agent is loaded *inside* the spawned test API server and points back at
 * that same server (self-loopback multi-hop), so there is no correct default
 * port to fall back to: the harness picks the port at random. Falling back
 * silently would build a URL for an unrelated process and surface much later
 * as a connection or agent-card error that never names the real cause.
 *
 * @throws If the environment variable is missing or not a positive integer.
 */
function requireServerPort(): number {
  const raw = process.env[PORT_ENV_VAR];
  if (!raw) {
    throw new Error(
      `${PORT_ENV_VAR} is not set. The multi_hop_remote_agent test agent ` +
        `runs inside the spawned test ADK API server and must point back at ` +
        `that same server, so it cannot fall back to a default port. ` +
        `AdkTsApiServer (tests/integration/test_api_server.ts) is ` +
        `responsible for propagating ${PORT_ENV_VAR} to the spawned process.`,
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
