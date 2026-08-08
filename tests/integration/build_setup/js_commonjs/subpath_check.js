/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
const assert = require('node:assert/strict'); // eslint-disable-line @typescript-eslint/no-require-imports
const path = require('node:path'); // eslint-disable-line @typescript-eslint/no-require-imports

/**
 * The optional subsystems `@google/adk/common` exists to leave unloaded, as
 * `node_modules` path fragments. `@opentelemetry/api` belongs to the common
 * graph, so only the OpenTelemetry SDK and exporters are denied.
 */
const HEAVY_PACKAGES = [
  'node_modules/@a2a-js/',
  'node_modules/@google-cloud/opentelemetry-',
  'node_modules/@google-cloud/storage/',
  'node_modules/@mikro-orm/',
  'node_modules/@modelcontextprotocol/',
  'node_modules/@opentelemetry/exporter-',
  'node_modules/@opentelemetry/sdk-',
  'node_modules/express/',
];

/** The loaded modules that belong to one of HEAVY_PACKAGES. */
function loadedHeavyModules() {
  return Object.keys(require.cache)
    .map((key) => key.split(path.sep).join('/'))
    .filter((key) => HEAVY_PACKAGES.some((pkg) => key.includes(pkg)));
}

const {LlmAgent} = require('@google/adk/common'); // eslint-disable-line @typescript-eslint/no-require-imports
assert.equal(typeof LlmAgent, 'function', '@google/adk/common lost LlmAgent');

const leaked = loadedHeavyModules();
assert.deepEqual(leaked, [], `@google/adk/common loaded ${leaked.join(', ')}`);
console.log('SUBPATH_ISOLATION_OK');

// Positive control: the root barrel does load them, so the check above cannot
// pass because the matcher is broken.
require('@google/adk'); // eslint-disable-line @typescript-eslint/no-require-imports
assert.notEqual(
  loadedHeavyModules().length,
  0,
  '@google/adk loaded none of HEAVY_PACKAGES, so the isolation check is vacuous',
);

const subpathExports = {
  '@google/adk/a2a': 'toA2a',
  '@google/adk/artifacts/gcs': 'GcsArtifactService',
  '@google/adk/integrations/agent-registry': 'AgentRegistry',
  '@google/adk/sessions/database': 'DatabaseSessionService',
  '@google/adk/telemetry': 'maybeSetOtelProviders',
  '@google/adk/tools/mcp': 'MCPToolset',
};

for (const [subpath, name] of Object.entries(subpathExports)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const exported = require(subpath)[name];
  assert.equal(
    typeof exported,
    'function',
    `${subpath} exported ${typeof exported} as ${name}`,
  );
}

console.log('SUBPATH_EXPORTS_OK');
