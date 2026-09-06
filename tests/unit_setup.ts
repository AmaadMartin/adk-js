/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterAll} from 'vitest';

/**
 * Environment variables that ADK production code reads directly. Unit tests
 * must not inherit them from the developer's shell: a unit test that needs a
 * value sets it explicitly, so that the suite behaves identically on a
 * contributor's machine and in CI, where none of these are set.
 *
 * Every name here has a reader under `core/src`, `dev/src` or
 * `integrations/src`. Ambient credential variables that ADK never reads
 * (`GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_*`) are deliberately absent:
 * deleting them would not make auth hermetic, because Application Default
 * Credentials also resolve via the gcloud well-known file and the metadata
 * server.
 */
export const SCRUBBED_ENV_VARS: readonly string[] = [
  'APIGEE_PROXY_URL',
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
];

/**
 * Families scrubbed by prefix. Feature flags are read under names built at
 * runtime (`ADK_ENABLE_${featureName}` in feature_registry.ts), so the ADK
 * family cannot be enumerated.
 */
export const SCRUBBED_ENV_PREFIXES: readonly string[] = ['ADK_'];

function isScrubbed(name: string): boolean {
  return (
    SCRUBBED_ENV_VARS.includes(name) ||
    SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

const inheritedEnv: Record<string, string> = {};

for (const name of Object.keys(process.env)) {
  const value = process.env[name];
  if (value !== undefined && isScrubbed(name)) {
    inheritedEnv[name] = value;
    delete process.env[name];
  }
}

afterAll(() => {
  Object.assign(process.env, inheritedEnv);
});
