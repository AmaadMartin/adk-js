/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';

const MODEL_NAME_PATTERN =
  '^projects/[^/]+/locations/[^/]+/publishers/[^/]+/models/(.+)$';

/**
 * Matches the Early Access Program (EAP) Gemini naming convention. Lower-case
 * only, and without the `g` flag so `.test()` stays stateless.
 */
const EAP_MODEL_NAME_PATTERN =
  /^gemini-[a-z0-9_]+(?:-[a-z0-9_]+)*-early-exp\d*$/;

/**
 * Extract the actual model name from either simple or path-based format.
 *
 * @param modelString Either a simple model name like "gemini-2.5-pro" or
 *     a path-based model name like "projects/.../models/gemini-2.0-flash-001"
 * @return The extracted model name (e.g., "gemini-2.5-pro")
 */
export function extractModelName(modelString: string): string {
  const match = modelString.match(MODEL_NAME_PATTERN);
  if (match) {
    return match[1];
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
  const modelName = extractModelName(modelString);

  return modelName.startsWith('gemini-1');
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
