/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {
  ApiClient,
  NodeAuth,
  NodeDownloader,
  NodeUploader,
} from '@google/genai/vertex_internal';
import {isEnterpriseModeEnabled} from './env_aware_utils.js';

export const EXPRESS_MODE_UNSUPPORTED_MESSAGE =
  'Vertex AI Express Mode (expressModeApiKey / GOOGLE_API_KEY) is not ' +
  'supported: the @google-cloud/vertexai Agent Engine client cannot send an ' +
  'API key. Provide projectId and location (with Application Default ' +
  'Credentials), or inject a preconfigured client.';

/**
 * Validates and returns the API key for Express Mode.
 *
 * The key is only returned when enterprise mode is enabled via
 * `GOOGLE_GENAI_USE_ENTERPRISE` (or the deprecated
 * `GOOGLE_GENAI_USE_VERTEXAI`).
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

  if (isEnterpriseModeEnabled()) {
    return expressModeApiKey || process.env.GOOGLE_API_KEY;
  }

  return undefined;
}

/**
 * Builds a Vertex AI API client that authenticates with an Express Mode API
 * key instead of Application Default Credentials.
 *
 * `NodeAuth` returns early when an API key is set and never constructs
 * `GoogleAuth`, so the client needs no credentials on the machine.
 *
 * @param apiKey The Express Mode API key.
 * @returns A client that signs requests with `apiKey`.
 */
export function createExpressModeApiClient(apiKey: string): ApiClient {
  return new ApiClient({
    auth: new NodeAuth({apiKey}),
    uploader: new NodeUploader(),
    downloader: new NodeDownloader(),
    vertexai: true,
    apiKey,
  });
}

/**
 * Builds the Agent Engine `Sessions` client from an `ApiClient`.
 *
 * `@google-cloud/vertexai` bundles its own nested copy of `@google/genai`
 * (1.52.0) while the repo root resolves `@google/genai` to 2.9.0, so the
 * `ApiClient` here is a structurally distinct class (its private fields make
 * the two nominally incompatible) from the one `Sessions` declares. The
 * instances are interchangeable at runtime -- the mismatch is a
 * duplicate-dependency artifact, not a real API difference -- so every caller
 * goes through this function rather than repeating the cast.
 *
 * @param apiClient The client to send Agent Engine requests with.
 * @returns A `Sessions` client backed by `apiClient`.
 */
export function createAgentEngineSessions(apiClient: ApiClient): Sessions {
  return new Sessions(
    apiClient as unknown as ConstructorParameters<typeof Sessions>[0],
  );
}
