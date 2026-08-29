/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWTInput} from 'google-auth-library';
import {formatError} from '../../../utils/error_utils.js';
import {extractResourceName} from '../resource_name_utils.js';

const APIHUB_ROOT_URL = 'https://apihub.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const CLOUD_PLATFORM_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
];
const NO_CREDENTIAL_MESSAGE =
  'Please provide a service account or an access token to API Hub client.';

/** Supplies the content of an API Hub spec. */
export interface BaseAPIHubClient {
  /**
   * Returns the spec of the given API Hub resource.
   *
   * @param resourceName The API, API version or API spec resource name.
   */
  getSpecContent(resourceName: string): Promise<string>;
}

/** Options for {@link APIHubClient}. */
export interface APIHubClientOptions {
  /**
   * A Google access token, for example from `gcloud auth
   * print-access-token`. Useful for local testing.
   */
  accessToken?: string;
  /** A service account key, as a JSON string. */
  serviceAccountJson?: string;
}

function parseServiceAccountJson(serviceAccountJson: string): JWTInput {
  try {
    return JSON.parse(serviceAccountJson) as JWTInput;
  } catch (e: unknown) {
    throw new Error(`Invalid service account JSON: ${formatError(e)}`);
  }
}

/** Reads APIs, API versions and API specs from the API Hub service. */
export class APIHubClient implements BaseAPIHubClient {
  private readonly accessToken?: string;
  private readonly serviceAccountJson?: string;
  private auth?: GoogleAuth;

  /**
   * Set either `accessToken` or `serviceAccountJson`. With neither, the client
   * uses Application Default Credentials.
   */
  constructor(options: APIHubClientOptions = {}) {
    this.accessToken = options.accessToken;
    this.serviceAccountJson = options.serviceAccountJson;
  }

  /**
   * Gets the first spec the given path resolves to.
   *
   * A path that names a spec returns that spec. A path that names only an API
   * or a version returns the first spec of the first version.
   *
   * @param path An API Hub resource path or console URL.
   * @returns The spec, or an empty string when the spec has no content.
   */
  async getSpecContent(path: string): Promise<string> {
    const names = extractResourceName(path);

    let apiVersionResourceName = names.apiVersionResourceName;
    if (!apiVersionResourceName) {
      const api = await this.get<{versions?: string[]}>(
        `${APIHUB_ROOT_URL}/${names.apiResourceName}`,
      );
      const versions = api.versions ?? [];
      if (versions.length === 0) {
        throw new Error(
          `No versions found in API Hub resource: ${names.apiResourceName}`,
        );
      }
      apiVersionResourceName = versions[0];
    }

    let apiSpecResourceName = names.apiSpecResourceName;
    if (!apiSpecResourceName) {
      const apiVersion = await this.get<{specs?: string[]}>(
        `${APIHUB_ROOT_URL}/${apiVersionResourceName}`,
      );
      const specs = apiVersion.specs ?? [];
      if (specs.length === 0) {
        throw new Error(
          `No specs found in API Hub version: ${apiVersionResourceName}`,
        );
      }
      apiSpecResourceName = specs[0];
    }

    const payload = await this.get<{contents?: string}>(
      `${APIHUB_ROOT_URL}/${apiSpecResourceName}:contents`,
    );
    return Buffer.from(payload.contents ?? '', 'base64').toString('utf-8');
  }

  private async get<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${await this.getAccessToken()}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `API Hub request failed with status ${response.status}: ${text}`,
      );
    }
    return (await response.json()) as T;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }
    // google-auth-library caches the token and refreshes it when it expires.
    this.auth ??= this.createAuth();

    let token: string | null | undefined;
    try {
      token = await this.auth.getAccessToken();
    } catch (e: unknown) {
      throw new Error(NO_CREDENTIAL_MESSAGE, {cause: e});
    }
    if (!token) {
      throw new Error(NO_CREDENTIAL_MESSAGE);
    }
    return token;
  }

  private createAuth(): GoogleAuth {
    if (!this.serviceAccountJson) {
      return new GoogleAuth({scopes: CLOUD_PLATFORM_SCOPES});
    }
    return new GoogleAuth({
      credentials: parseServiceAccountJson(this.serviceAccountJson),
      scopes: CLOUD_PLATFORM_SCOPES,
    });
  }
}
