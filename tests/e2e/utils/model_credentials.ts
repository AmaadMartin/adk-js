/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reports whether the ambient environment can authenticate
 * `new Gemini({model})` with no explicit `apiKey`/`vertexai`/`project`/
 * `location`, mirroring the branch in `geminiInitParams`. Note that
 * `GOOGLE_CLOUD_PROJECT` alone satisfies neither path.
 */
export function hasModelCredentials(): boolean {
  const useVertexAi = ['true', '1'].includes(
    (process.env['GOOGLE_GENAI_USE_VERTEXAI'] || '').toLowerCase(),
  );
  if (useVertexAi) {
    return (
      !!process.env['GOOGLE_CLOUD_PROJECT'] &&
      !!process.env['GOOGLE_CLOUD_LOCATION']
    );
  }
  return (
    !!process.env['GOOGLE_GENAI_API_KEY'] || !!process.env['GEMINI_API_KEY']
  );
}
