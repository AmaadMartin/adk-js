/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Values `getBooleanEnvVar` treats as true, lower-cased. */
const VERTEX_ENABLED_VALUES = ['true', '1'];

/**
 * Reports whether the Vertex path would be selected for a `Gemini` built
 * without an explicit `vertexai` flag.
 */
function useVertexAi(): boolean {
  return VERTEX_ENABLED_VALUES.includes(
    (process.env['GOOGLE_GENAI_USE_VERTEXAI'] || '').toLowerCase(),
  );
}

/**
 * Reports whether the ambient environment can authenticate a Gemini model that
 * is constructed with no explicit `apiKey`, `vertexai`, `project` or
 * `location` — i.e. `new Gemini({model})` or an `LlmAgent` given a bare model
 * string.
 *
 * This mirrors the branch in `geminiInitParams`
 * (`core/src/models/google_llm.ts`): the Vertex path is selected by
 * `GOOGLE_GENAI_USE_VERTEXAI` alone (accepted values `true`/`1`, matching
 * `getBooleanEnvVar` in `core/src/utils/env_aware_utils.ts`), and it needs
 * both a project and a location; otherwise an API key is required.
 * `GOOGLE_CLOUD_PROJECT` on its own satisfies neither path.
 *
 * Must be called (not evaluated at import time) so that a test file's
 * `dotenv.config()` has already run.
 */
export function hasModelCredentials(): boolean {
  if (useVertexAi()) {
    return (
      !!process.env['GOOGLE_CLOUD_PROJECT'] &&
      !!process.env['GOOGLE_CLOUD_LOCATION']
    );
  }
  return (
    !!process.env['GOOGLE_GENAI_API_KEY'] || !!process.env['GEMINI_API_KEY']
  );
}
