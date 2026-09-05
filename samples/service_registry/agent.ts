/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Service registry: a session backend declared beside the agent.
 *
 * `services.yaml` in this directory binds the `demo://` scheme to
 * `DemoSessionService`. The agent itself needs no model, so the run is
 * deterministic and offline.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/service_registry/agent.ts \
 *     --session_service_uri demo://local
 */

import {node, Workflow} from '@google/adk';

const echo = node((_ctx, nodeInput: string) => `You said: ${nodeInput}`, {
  name: 'echo',
});

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', echo]],
});
