/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWTInput} from 'google-auth-library';
import {formatError} from '../../../utils/error_utils.js';

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

/** The resource names an API Hub path resolves to. */
export interface ApiHubResourceNames {
  /** `projects/*\/locations/*\/apis/*`. */
  apiResourceName: string;
  /** `projects/*\/locations/*\/apis/*\/versions/*`, when the path names one. */
  apiVersionResourceName?: string;
  /** The spec resource name, when the path names both a version and a spec. */
  apiSpecResourceName?: string;
}

/** An API Hub API resource. Declares the fields this client reads. */
export interface ApiHubApi {
  name?: string;
  /** Resource names of the API's versions. */
  versions?: string[];
}

/** An API Hub API version resource. Declares the fields this client reads. */
export interface ApiHubApiVersion {
  name?: string;
  /** Resource names of the version's specs. */
  specs?: string[];
}

interface ApiHubApiList {
  apis?: ApiHubApi[];
}

interface ApiHubSpecContents {
  /** The base64-encoded spec. */
  contents?: string;
}

function segmentAfter(segments: string[], keyword: string): string | undefined {
  const index = segments.indexOf(keyword);
  return index === -1 ? undefined : segments[index + 1];
}

function splitPathAndProject(urlOrPath: string): {
  path: string;
  queryProject?: string;
} {
  let path: string;
  let queryProject: string | undefined;
  try {
    const url = new URL(urlOrPath, 'http://localhost');
    path = url.pathname;
    queryProject = url.searchParams.get('project') ?? undefined;
  } catch {
    return {path: urlOrPath};
  }
  // A path copied from the API Hub console carries a UI prefix.
  if (path.includes('api-hub/')) {
    path = path.split('api-hub')[1];
  }
  return {path, queryProject};
}

function parseServiceAccountJson(serviceAccountJson: string): JWTInput {
  try {
    return JSON.parse(serviceAccountJson) as JWTInput;
  } catch (e: unknown) {
    throw new Error(`Invalid service account JSON: ${formatError(e)}`);
  }
}

/**
 * Extracts the API, API version and API spec resource names from an API Hub
 * path or console URL.
 *
 * Accepts a resource path such as
 * `projects/p/locations/l/apis/a/versions/v/specs/s`, or a console URL such as
 * `https://console.cloud.google.com/apigee/api-hub/projects/p/locations/l/apis/a?project=p`.
 *
 * @param urlOrPath The API Hub path or console URL.
 * @returns The resource names the path resolves to.
 * @throws If the path names no project, no location or no API.
 */
export function extractResourceName(urlOrPath: string): ApiHubResourceNames {
  const {path, queryProject} = splitPathAndProject(urlOrPath);
  const segments = path.split('/').filter((segment) => segment !== '');

  const project = segments.includes('projects')
    ? segmentAfter(segments, 'projects')
    : queryProject;
  if (!project) {
    throw new Error(
      'Project ID not found in URL or path in APIHubClient. Input path is' +
        ` '${urlOrPath}'. Please make sure there is either` +
        " '/projects/PROJECT_ID' in the path or 'project=PROJECT_ID' query" +
        ' param in the input.',
    );
  }

  const location = segmentAfter(segments, 'locations');
  if (!location) {
    throw new Error(
      'Location not found in URL or path in APIHubClient. Input path is' +
        ` '${urlOrPath}'. Please make sure there is either` +
        " '/location/LOCATION_ID' in the path.",
    );
  }

  const apiId = segmentAfter(segments, 'apis');
  if (!apiId) {
    throw new Error(
      'API id not found in URL or path in APIHubClient. Input path is' +
        ` '${urlOrPath}'. Please make sure there is either '/apis/API_ID' in` +
        ' the path.',
    );
  }

  const versionId = segmentAfter(segments, 'versions');
  const specId = segmentAfter(segments, 'specs');

  const apiResourceName = `projects/${project}/locations/${location}/apis/${apiId}`;
  const apiVersionResourceName = versionId
    ? `${apiResourceName}/versions/${versionId}`
    : undefined;
  return {
    apiResourceName,
    apiVersionResourceName,
    apiSpecResourceName:
      apiVersionResourceName && specId
        ? `${apiVersionResourceName}/specs/${specId}`
        : undefined,
  };
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
   * Lists the APIs of a project and location.
   *
   * @param project The Google Cloud project id.
   * @param location The API Hub location, for example `us-central1`.
   */
  async listApis(project: string, location: string): Promise<ApiHubApi[]> {
    const payload = await this.get<ApiHubApiList>(
      `${APIHUB_ROOT_URL}/projects/${project}/locations/${location}/apis`,
    );
    return payload.apis ?? [];
  }

  /**
   * Gets an API.
   *
   * @param apiResourceName `projects/p/locations/l/apis/a`.
   */
  async getApi(apiResourceName: string): Promise<ApiHubApi> {
    return this.get<ApiHubApi>(`${APIHUB_ROOT_URL}/${apiResourceName}`);
  }

  /**
   * Gets an API version.
   *
   * @param apiVersionName `projects/p/locations/l/apis/a/versions/v`.
   */
  async getApiVersion(apiVersionName: string): Promise<ApiHubApiVersion> {
    return this.get<ApiHubApiVersion>(`${APIHUB_ROOT_URL}/${apiVersionName}`);
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
      const api = await this.getApi(names.apiResourceName);
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
      const apiVersion = await this.getApiVersion(apiVersionResourceName);
      const specs = apiVersion.specs ?? [];
      if (specs.length === 0) {
        throw new Error(
          `No specs found in API Hub version: ${apiVersionResourceName}`,
        );
      }
      apiSpecResourceName = specs[0];
    }

    return this.fetchSpec(apiSpecResourceName);
  }

  private async fetchSpec(apiSpecResourceName: string): Promise<string> {
    const payload = await this.get<ApiHubSpecContents>(
      `${APIHUB_ROOT_URL}/${apiSpecResourceName}:contents`,
    );
    if (!payload.contents) {
      return '';
    }
    return Buffer.from(payload.contents, 'base64').toString('utf-8');
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
