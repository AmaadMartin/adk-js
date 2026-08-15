/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from './env_aware_utils.js';

export const EXPRESS_MODE_UNSUPPORTED_MESSAGE =
  'Vertex AI Express Mode (expressModeApiKey / GOOGLE_API_KEY) is not ' +
  'supported: the @google-cloud/vertexai Agent Engine client cannot send an ' +
  'API key. Provide projectId and location (with Application Default ' +
  'Credentials), or inject a preconfigured client.';

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

const AGENT_ENGINE_RESOURCE_NAME =
  /^projects\/([^/]+)\/locations\/([^/]+)\/reasoningEngines\/([^/]+)$/;

export interface AgentEngineResourceName {
  projectId: string;
  location: string;
  agentEngineId: string;
}

/**
 * Parses `projects/{project}/locations/{location}/reasoningEngines/{id}` into
 * its three components.
 *
 * Each segment accepts anything but a `/`, matching how adk-python validates
 * the same resource name.
 *
 * @param name The resource name to parse.
 * @returns The components, or undefined when the name does not match. The
 *     caller reports the failure, so that the error can name its own input.
 */
export function parseAgentEngineResourceName(
  name: string,
): AgentEngineResourceName | undefined {
  const parts = AGENT_ENGINE_RESOURCE_NAME.exec(name);

  if (!parts) {
    return undefined;
  }

  return {projectId: parts[1], location: parts[2], agentEngineId: parts[3]};
}

/**
 * Resolves an agent engine resource to its project, location and id.
 *
 * The resource is either a bare agent engine id, in which case the project and
 * the location come from the environment, or a fully qualified resource name.
 * Both forms resolve to the bare id, because the callers address the agent
 * engine by id rather than by path.
 *
 * @param resource The bare id or the full resource name.
 * @returns The resolved components.
 */
export function resolveAgentEngineResource(
  resource: string,
): AgentEngineResourceName {
  if (!resource) {
    throw new Error(
      'Agent engine resource name or resource id cannot be empty.',
    );
  }

  if (!resource.includes('/')) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION;

    if (!projectId || !location) {
      throw new Error(
        'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must both be set to ' +
          'use an agent engine resource id. Use the full resource name ' +
          'projects/{project}/locations/{location}/reasoningEngines/{id} to ' +
          'avoid that requirement.',
      );
    }

    return {projectId, location, agentEngineId: resource};
  }

  const parsed = parseAgentEngineResourceName(resource);

  if (!parsed) {
    throw new Error(
      'Agent engine resource name is mal-formatted. It should be of format: ' +
        'projects/{project}/locations/{location}/reasoningEngines/{id}',
    );
  }

  return parsed;
}
