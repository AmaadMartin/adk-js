/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions} from '@google/genai';
import {
  ApiClient,
  NodeAuth,
  NodeDownloader,
  NodeUploader,
} from '@google/genai/vertex_internal';

import {isEnterpriseModeEnabled} from './env_aware_utils.js';

/** The OAuth scope Application Default Credentials are requested with. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

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

/** The credentials and endpoint a Vertex AI API client is built from. */
export interface VertexAiApiClientOptions {
  /** Express Mode API key. Replaces Application Default Credentials. */
  apiKey?: string;
  /** The project id, for Application Default Credentials. */
  project?: string;
  /** The location, for Application Default Credentials. */
  location?: string;
  /** Endpoint, API version and header overrides. */
  httpOptions?: HttpOptions;
}

/**
 * Builds a Vertex AI API client.
 *
 * With `apiKey` set the client authenticates in Express Mode: `NodeAuth`
 * returns the key header directly and never constructs `GoogleAuth`, so no
 * Application Default Credentials are needed. Without it the client falls back
 * to Application Default Credentials for `project` and `location`.
 */
export function createVertexAiApiClient(
  options: VertexAiApiClientOptions,
): ApiClient {
  return new ApiClient({
    auth: options.apiKey
      ? new NodeAuth({apiKey: options.apiKey})
      : new NodeAuth({
          googleAuthOptions: {scopes: [CLOUD_PLATFORM_SCOPE]},
        }),
    uploader: new NodeUploader(),
    downloader: new NodeDownloader(),
    vertexai: true,
    apiKey: options.apiKey,
    project: options.project,
    location: options.location,
    httpOptions: options.httpOptions,
  });
}
