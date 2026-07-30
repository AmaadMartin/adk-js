/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cloud configuration and credential variables that a developer machine is
 * likely to export (via `gcloud`, a shell profile, or a sourced `.env`).
 *
 * All but one are read straight from `process.env` by ADK source.
 * `GOOGLE_APPLICATION_CREDENTIALS` is the exception: it is consumed by
 * `google-auth-library` beneath the genai SDK, so grepping ADK for it finds
 * nothing. Keep it in the list -- it is the entry that points at real
 * credentials.
 */
export const AMBIENT_CLOUD_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
];

/**
 * Removes the ambient cloud configuration from `env`.
 *
 * GitHub Actions runners never export these variables, so a unit test that
 * reads one of them passes in CI and fails only on a developer machine.
 * Unit tests that need a value set one explicitly with `vi.stubEnv`.
 *
 * This module is deliberately free of side effects: `hermetic_env_setup.ts` is
 * what applies the scrub. That split is what lets a test import the list and
 * still observe whether the setup file actually ran.
 */
export function scrubAmbientCloudEnv(
  env: Record<string, string | undefined> = process.env,
) {
  for (const name of AMBIENT_CLOUD_ENV_VARS) {
    delete env[name];
  }
}
