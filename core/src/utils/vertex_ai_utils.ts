/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentEngines} from '@google-cloud/vertexai/build/src/genai/agentengines.js';
import {
  Client,
  SDK_VERSION,
} from '@google-cloud/vertexai/build/src/genai/client.js';
import {
  ApiClient,
  NodeAuth,
  NodeDownloader,
  NodeUploader,
} from '@google/genai/vertex_internal';
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

/**
 * The credentials used to reach the Vertex AI Agent Engines API.
 *
 * An express mode API key and a project/location pair are mutually exclusive;
 * see {@link getExpressModeApiKey}.
 */
export interface AgentEnginesClientOptions {
  projectId?: string;
  location?: string;
  expressModeApiKey?: string;
}

/**
 * Builds the genai API client used for Vertex AI express mode.
 *
 * `@google-cloud/vertexai`'s `Client` has no API key option: it always
 * authenticates with Application Default Credentials and requires a project
 * and location, so express mode has to build the underlying client itself. The
 * key is passed to `NodeAuth`, which emits the `x-goog-api-key` header, as well
 * as to `ApiClient`, which uses it to skip the `projects/{p}/locations/{l}` URL
 * prefix.
 */
export function createExpressModeApiClient(apiKey: string): ApiClient {
  return new ApiClient({
    auth: new NodeAuth({apiKey}),
    uploader: new NodeUploader(),
    downloader: new NodeDownloader(),
    apiKey,
    vertexai: true,
    userAgentExtra: `vertex-genai-modules/${SDK_VERSION}`,
  });
}

/** The `ApiClient` declaration that `AgentEngines` is compiled against. */
type AgentEnginesApiClient = ConstructorParameters<typeof AgentEngines>[0];

/**
 * Creates the Agent Engines client for the given credentials.
 *
 * An express mode API key wins over a project/location pair, matching
 * `_get_api_client` in the Python ADK.
 */
export function createAgentEnginesClient(
  options: AgentEnginesClientOptions,
): AgentEngines {
  if (options.expressModeApiKey) {
    const apiClient = createExpressModeApiClient(options.expressModeApiKey);
    // `AgentEngines` is compiled against the `@google/genai` copy that
    // `@google-cloud/vertexai@1.12.0` resolves (v1.52.0), while `core` resolves
    // `@google/genai` v2.9.0. The two `ApiClient` classes are the same at
    // runtime but nominally distinct to `tsc` because of the private
    // `customBaseUrl` field.
    return new AgentEngines(apiClient as unknown as AgentEnginesApiClient);
  }
  return new Client({
    project: options.projectId,
    location: options.location,
  }).agentEnginesInternal;
}
