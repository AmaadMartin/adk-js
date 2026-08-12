/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The environment variables `tests/unit_setup.ts` deletes, and the function
 * that deletes them.
 *
 * This module has no side effect on import, which is what lets a test read the
 * lists without performing the scrub itself. `tests/unit_setup.ts` is the file
 * that applies it.
 */

/**
 * Environment variables that ADK production code reads by name.
 *
 * Every entry has a reader under `core/src`, `dev/src` or `integrations/src`.
 * `GOOGLE_APPLICATION_CREDENTIALS` and `CLOUDSDK_*` are absent on purpose: ADK
 * never reads them, and deleting them would not make authentication hermetic,
 * because Application Default Credentials also resolve through the gcloud
 * well-known file and the metadata server.
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
 * Prefixes of environment variables ADK builds at runtime.
 *
 * `core/src/features/feature_registry.ts` derives `ADK_ENABLE_<feature>` and
 * `ADK_DISABLE_<feature>` from the feature name, so the family cannot be
 * enumerated.
 */
export const SCRUBBED_ENV_PREFIXES: readonly string[] = ['ADK_'];

/** An environment: variable name to value, as `process.env` is shaped. */
export type EnvVars = Record<string, string | undefined>;

/** Deletes every scrubbed variable from `env`. Sets nothing. */
export function scrubEnv(env: EnvVars): void {
  for (const name of SCRUBBED_ENV_VARS) {
    delete env[name];
  }
  for (const name of Object.keys(env)) {
    if (SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete env[name];
    }
  }
}
