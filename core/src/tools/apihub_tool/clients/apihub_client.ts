/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWTInput} from 'google-auth-library';
import {Buffer} from 'node:buffer';

const API_HUB_ROOT_URL = 'https://apihub.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const CLOUD_PLATFORM_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
];
const NO_CREDENTIAL_MESSAGE =
  'Please provide a service account or an access token to API Hub client.';

/** An API registered in API Hub. */
export interface ApiHubApi {
  name?: string;
  /** Resource names of the API's versions. */
  versions?: string[];
}

/** A version of an API registered in API Hub. */
export interface ApiHubApiVersion {
  name?: string;
  /** Resource names of the version's specs. */
  specs?: string[];
}

/** The response of the API Hub `apis.list` method. */
interface ApiHubApiList {
  apis?: ApiHubApi[];
}

/** The response of the API Hub `specs.contents` method. */
interface ApiHubSpecContents {
  /** The base64-encoded spec text. */
  contents?: string;
}

/** The API, version and spec resource names parsed out of a path or URL. */
export interface ApiHubResourceNames {
  /** The API resource name. Always present. */
  apiResourceName: string;
  /** The API version resource name, when the input named a version. */
  apiVersionResourceName?: string;
  /** The API spec resource name, when the input named a spec. */
  apiSpecResourceName?: string;
}

/** Seam for fetching an OpenAPI spec out of Google Cloud API Hub. */
export interface BaseAPIHubClient {
  /** From a given resource name, get the spec text from API Hub. */
  getSpecContent(resourceName: string): Promise<string>;
}

/** Returns the segment that follows `key`, or undefined if there is none. */
function segmentAfter(segments: string[], key: string): string | undefined {
  const index = segments.indexOf(key);
  return index !== -1 ? segments.at(index + 1) : undefined;
}

/**
 * Extracts the API, API version and API spec resource names from an API Hub
 * resource path or a Cloud Console API Hub URL.
 *
 * @param urlOrPath A resource path
 *     (`projects/p/locations/l/apis/a/versions/v/specs/s`, with everything from
 *     `versions` on optional) or the Console URL for the same resource.
 * @returns The resource names found in the input.
 * @throws If the project, location or API id is missing from the input.
 */
export function extractResourceName(urlOrPath: string): ApiHubResourceNames {
  let path = urlOrPath;
  let query: URLSearchParams | undefined;
  if (URL.canParse(urlOrPath)) {
    const url = new URL(urlOrPath);
    path = url.pathname;
    query = url.searchParams;
  }

  // The segment walk below ignores any Console UI route prefix on its own, so
  // the path needs no stripping. adk-python strips everything before
  // 'api-hub/', which corrupts a resource path whose API id is 'api-hub'.
  const segments = path.split('/').filter(Boolean);

  const project = segmentAfter(segments, 'projects') ?? query?.get('project');
  if (!project) {
    throw new Error(
      `Project ID not found in URL or path in APIHubClient. Input path is '${urlOrPath}'. Please make sure there is either '/projects/PROJECT_ID' in the path or 'project=PROJECT_ID' query param in the input.`,
    );
  }

  const location = segmentAfter(segments, 'locations');
  if (!location) {
    throw new Error(
      `Location not found in URL or path in APIHubClient. Input path is '${urlOrPath}'. Please make sure there is either '/location/LOCATION_ID' in the path.`,
    );
  }

  const apiId = segmentAfter(segments, 'apis');
  if (!apiId) {
    throw new Error(
      `API id not found in URL or path in APIHubClient. Input path is '${urlOrPath}'. Please make sure there is either '/apis/API_ID' in the path.`,
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

/** Parses a service account JSON string without leaking it into the error. */
function parseServiceAccountJson(serviceAccountJson: string): JWTInput {
  try {
    return JSON.parse(serviceAccountJson) as JWTInput;
  } catch (e: unknown) {
    throw new Error(
      `Invalid service account JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Client for the Google Cloud API Hub service.
 *
 * Requests are authenticated with an explicit access token, an explicit
 * service account JSON string, or Application Default Credentials, in that
 * order of precedence.
 */
export class APIHubClient implements BaseAPIHubClient {
  private readonly accessToken?: string;
  private readonly serviceAccountJson?: string;
  private auth?: GoogleAuth;

  /**
   * @param options.accessToken Google access token, e.g. from
   *     `gcloud auth print-access-token`. Useful for local testing.
   * @param options.serviceAccountJson Service account config as a JSON string.
   *     Required if not relying on Application Default Credentials.
   */
  constructor(
    options: {accessToken?: string; serviceAccountJson?: string} = {},
  ) {
    this.accessToken = options.accessToken;
    this.serviceAccountJson = options.serviceAccountJson;
  }

  /**
   * From a given path, gets the first spec available in API Hub.
   *
   * - A path naming only an API resolves to the first spec of its first
   *   version.
   * - A path naming an API version resolves to the first spec of that version.
   * - A path naming a spec resolves to that spec.
   *
   * @param path An API Hub resource path or Cloud Console API Hub URL.
   * @returns The decoded spec text.
   */
  async getSpecContent(path: string): Promise<string> {
    const {apiResourceName, apiVersionResourceName, apiSpecResourceName} =
      extractResourceName(path);

    let versionName = apiVersionResourceName;
    if (!versionName) {
      const versions = (await this.getApi(apiResourceName)).versions ?? [];
      if (versions.length === 0) {
        throw new Error(
          `No versions found in API Hub resource: ${apiResourceName}`,
        );
      }
      versionName = versions[0];
    }

    let specName = apiSpecResourceName;
    if (!specName) {
      const specs = (await this.getApiVersion(versionName)).specs ?? [];
      if (specs.length === 0) {
        throw new Error(`No specs found in API Hub version: ${versionName}`);
      }
      specName = specs[0];
    }

    const {contents} = await this.get<ApiHubSpecContents>(
      `${API_HUB_ROOT_URL}/${specName}:contents`,
    );
    return contents ? Buffer.from(contents, 'base64').toString('utf-8') : '';
  }

  /**
   * Lists all APIs in the given project and location.
   *
   * @param project The Google Cloud project name.
   * @param location The location of the API Hub resources, e.g. 'us-central1'.
   * @returns The APIs, or an empty list when the project has none.
   */
  async listApis(project: string, location: string): Promise<ApiHubApi[]> {
    const list = await this.get<ApiHubApiList>(
      `${API_HUB_ROOT_URL}/projects/${project}/locations/${location}/apis`,
    );
    return list.apis ?? [];
  }

  /**
   * Gets the details of an API.
   *
   * @param apiResourceName Resource name of the API, like
   *     `projects/p/locations/us-central1/apis/a`.
   */
  async getApi(apiResourceName: string): Promise<ApiHubApi> {
    return this.get<ApiHubApi>(`${API_HUB_ROOT_URL}/${apiResourceName}`);
  }

  /**
   * Gets the details of an API version.
   *
   * @param apiVersionName Resource name of the API version.
   */
  async getApiVersion(apiVersionName: string): Promise<ApiHubApiVersion> {
    return this.get<ApiHubApiVersion>(`${API_HUB_ROOT_URL}/${apiVersionName}`);
  }

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${await this.getAccessToken()}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `API Hub request failed with status ${res.status}: ${text}`,
      );
    }
    return (await res.json()) as T;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    // Cache the GoogleAuth instance so its own token cache is reused.
    this.auth ??= this.serviceAccountJson
      ? new GoogleAuth({
          credentials: parseServiceAccountJson(this.serviceAccountJson),
          scopes: CLOUD_PLATFORM_SCOPES,
        })
      : new GoogleAuth({scopes: CLOUD_PLATFORM_SCOPES});

    let token: string | null | undefined;
    try {
      const client = await this.auth.getClient();
      token = (await client.getAccessToken()).token;
    } catch (cause: unknown) {
      throw new Error(NO_CREDENTIAL_MESSAGE, {cause});
    }
    if (!token) {
      throw new Error(NO_CREDENTIAL_MESSAGE);
    }
    return token;
  }
}
