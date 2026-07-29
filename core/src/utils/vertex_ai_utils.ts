/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';

/**
 * Validates and returns the API key for Express Mode.
 *
 * @param project The project id.
 * @param location The location.
 * @param expressModeApiKey The API key for Express Mode.
 * @returns The resolved API key or undefined.
 */
export function getExpressModeApiKey(
  project?: string,
  location?: string,
  expressModeApiKey?: string,
): string | undefined {
  if ((project || location) && expressModeApiKey) {
    throw new Error(
      'Cannot specify project or location and expressModeApiKey. ' +
        'Either use project and location, or just the expressModeApiKey.',
    );
  }

  if (getBooleanEnvVar('GOOGLE_GENAI_USE_VERTEXAI')) {
    return expressModeApiKey || process.env.GOOGLE_API_KEY;
  }

  return undefined;
}

const REASONING_ENGINE_NAME_PATTERN =
  /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;

/**
 * The parsed components of a Vertex AI reasoning engine resource name.
 */
export interface ReasoningEngineName {
  projectId: string;
  location: string;
  reasoningEngineId: string;
}

/**
 * Parses a fully-qualified Vertex AI reasoning engine resource name.
 *
 * @param name A resource name of the form
 *     `projects/{project}/locations/{location}/reasoningEngines/{id}`.
 * @return The parsed components, or undefined if `name` is not a
 *     fully-qualified reasoning engine resource name.
 */
export function parseReasoningEngineName(
  name: string,
): ReasoningEngineName | undefined {
  const match = name.match(REASONING_ENGINE_NAME_PATTERN);
  if (!match) {
    return undefined;
  }
  return {
    projectId: match[1],
    location: match[2],
    reasoningEngineId: match[3],
  };
}
