/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';

/**
 * Path-based model name patterns, tried in order: the Vertex AI publisher path
 * and the Apigee path (`apigee/[<provider>/][<version>/]<model_id>`). Declared
 * without the `g` flag so `.match()` stays stateless.
 */
const MODEL_PATH_PATTERNS = [
  /^projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/(.+)$/,
  /^apigee\/(?:[^/]+\/)?(?:[^/]+\/)?(.+)$/,
];

const MODELS_PREFIX = 'models/';

/**
 * Matches the Early Access Program (EAP) Gemini naming convention. Lower-case
 * only, and without the `g` flag so `.test()` stays stateless.
 */
const EAP_MODEL_NAME_PATTERN =
  /^gemini-[a-z0-9_]+(?:-[a-z0-9_]+)*-early-exp\d*$/;

/**
 * Matches Gemini 1.x names such as `gemini-1.5-pro`. The dotted minor version
 * is mandatory, so a future double-digit major like `gemini-10.0-pro` is not
 * mistaken for Gemini 1.x.
 */
const GEMINI_1_MODEL_NAME_PATTERN = /^gemini-1\.\d+/;

/**
 * Extract the actual model name from a simple, path-based, `models/`-prefixed
 * or provider-prefixed model string.
 *
 * Supported forms:
 * - simple: `gemini-2.5-pro`
 * - Vertex AI path:
 *   `projects/.../locations/.../publishers/google/models/gemini-2.0-flash-001`
 * - Apigee path: `apigee/vertex_ai/v1beta/gemini-2.5-flash`
 * - `models/` prefixed: `models/gemini-2.5-pro`
 * - provider-prefixed, LiteLLM style: `gemini/gemini-2.5-flash`,
 *   `openrouter/google/gemini-2.5-pro:online`. Only Gemini ids are extracted
 *   from this form; other providers fall through unchanged.
 *
 * @param modelString The model string, in any of the forms above.
 * @return The extracted model name (e.g., "gemini-2.5-pro"), or the input
 *     unchanged when no form applies.
 */
export function extractModelName(modelString: string): string {
  for (const pattern of MODEL_PATH_PATTERNS) {
    const match = modelString.match(pattern);
    if (match) {
      return match[1];
    }
  }

  if (modelString.startsWith(MODELS_PREFIX)) {
    return modelString.slice(MODELS_PREFIX.length);
  }

  // A 'projects/' string reaching here is a malformed Vertex path. Return it
  // before the provider-prefix branch below reads its last segment as an id.
  if (modelString.startsWith('projects/')) {
    return modelString;
  }

  if (modelString.includes('/')) {
    const modelName = modelString.slice(modelString.lastIndexOf('/') + 1);
    if (modelName.startsWith('gemini-')) {
      return modelName;
    }
  }

  // If it's not a path-based model, return as-is (simple model name)
  return modelString;
}

/**
 * Check if the model is a Gemini model using regex patterns.
 *
 * @param modelString Either a simple model name or path - based model name
 * @return true if it's a Gemini model, false otherwise.
 */
export function isGeminiModel(modelString: string): boolean {
  const modelName = extractModelName(modelString);

  return modelName.startsWith('gemini-');
}

interface ParsedVersion {
  valid: boolean;
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(versionString: string): ParsedVersion {
  if (!/^\d+(\.\d+)*$/.test(versionString)) {
    return {valid: false, major: 0, minor: 0, patch: 0};
  }
  const parts = versionString.split('.').map((part) => parseInt(part, 10));

  return {
    valid: true,
    major: parts[0],
    minor: parts.length > 1 ? parts[1] : 0,
    patch: parts.length > 2 ? parts[2] : 0,
  };
}

/**
 * Check if the model is a Gemini 1.x model using regex patterns.
 *
 * @param modelString Either a simple model name or path - based model name
 * @return true if it's a Gemini 1.x model, false otherwise.
 */
export function isGemini1Model(modelString: string): boolean {
  return GEMINI_1_MODEL_NAME_PATTERN.test(extractModelName(modelString));
}

/**
 * Check if the model is a Gemini EAP or a Gemini 2.0+ model.
 *
 * EAP Gemini models do not encode a numeric version, so they are matched
 * first by their naming convention — `gemini-<variant>-early-exp` with an
 * optional numeric suffix, e.g. `gemini-flash-early-exp` or
 * `gemini-flash-early-exp3`. Otherwise the model name is parsed as a version
 * and matches when the major version is >= 2.
 *
 * @param modelString Either a simple model name or path - based model name
 * @return true if it's a Gemini EAP model or a Gemini 2.0+ model, false
 *     otherwise.
 */
export function isGemini2OrAbove(modelString: string): boolean {
  if (!modelString) {
    return false;
  }

  const modelName = extractModelName(modelString);

  if (EAP_MODEL_NAME_PATTERN.test(modelName)) {
    return true;
  }

  if (!modelName.startsWith('gemini-')) {
    return false;
  }

  const versionString = modelName.slice('gemini-'.length).split('-', 1)[0];

  const parsedVersion = parseVersion(versionString);
  return parsedVersion.valid && parsedVersion.major >= 2;
}

/**
 * Check if the model is a Gemini 3.x Flash Live model.
 *
 * @param modelString Either a simple model name or path-based model name
 * @return true if it's a Gemini 3.x Flash Live model, false otherwise.
 */
export function isGemini3xFlashLive(modelString: string | undefined): boolean {
  if (!modelString) {
    return false;
  }
  const modelName = extractModelName(modelString);
  return modelName.startsWith('gemini-3.') && modelName.includes('-flash-live');
}

/**
 * Returns True when Gemini model-id validation should be bypassed.
 */
export function isGeminiModelIdCheckDisabled(): boolean {
  return getBooleanEnvVar('ADK_DISABLE_GEMINI_MODEL_ID_CHECK');
}
