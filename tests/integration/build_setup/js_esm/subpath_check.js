/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toA2a} from '@google/adk/a2a';
import {GcsArtifactService} from '@google/adk/artifacts/gcs';
import {LlmAgent} from '@google/adk/common';
import {AgentRegistry} from '@google/adk/integrations/agent-registry';
import {DatabaseSessionService} from '@google/adk/sessions/database';
import {maybeSetOtelProviders} from '@google/adk/telemetry';
import {MCPToolset} from '@google/adk/tools/mcp';
import assert from 'node:assert/strict';

const subpathExports = {
  '@google/adk/a2a': toA2a,
  '@google/adk/artifacts/gcs': GcsArtifactService,
  '@google/adk/common': LlmAgent,
  '@google/adk/integrations/agent-registry': AgentRegistry,
  '@google/adk/sessions/database': DatabaseSessionService,
  '@google/adk/telemetry': maybeSetOtelProviders,
  '@google/adk/tools/mcp': MCPToolset,
};

for (const [subpath, value] of Object.entries(subpathExports)) {
  assert.equal(typeof value, 'function', `${subpath} exported ${typeof value}`);
}

console.log('SUBPATH_EXPORTS_OK');
