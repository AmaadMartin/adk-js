/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';

const API_HUB_ROOT_URL = 'https://apihub.googleapis.com/v1';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Extracted API Hub resource names from a resource path or UI URL.
 */
export type ExtractedResourceNames = [
  apiResourceName: string,
  apiVersionResourceName: string | undefined,
  apiSpecResourceName: string | undefined,
];

/**
 * Cached credential token state.
 */
export interface CachedCredential {
  token: string;
  expired: boolean;
  refresh?: () => Promise<string>;
}

/**
 * Configuration options for initializing an {@link APIHubClient}.
 */
export interface APIHubClientOptions {
  /**
   * Google OAuth2 access token used for authenticating requests to API Hub.
   */
  accessToken?: string;
  /**
   * Service account configuration as a JSON string or parsed object.
   */
  serviceAccountJson?: string | Record<string, unknown>;
  /**
   * Optional GoogleAuth instance for resolving credentials.
   */
  auth?: GoogleAuth;
}

/**
 * Extracts the resource names of an API, API Version, and API Spec from a URL or path.
 *
 * @param urlOrPath The UI URL, API URL, or resource path string.
 * @returns A tuple of `[apiResourceName, apiVersionResourceName, apiSpecResourceName]`.
 * @throws {Error} If the URL or path is missing `project`, `location`, or `api` identifiers.
 */
export function extractResourceName(urlOrPath: string): ExtractedResourceNames {
  let path = urlOrPath;
  let queryParams: URLSearchParams | undefined;

  try {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(urlOrPath)) {
      const parsedUrl = new URL(urlOrPath);
      path = parsedUrl.pathname;
      queryParams = parsedUrl.searchParams;
    } else {
      const [rawPath, rawQuery] = urlOrPath.split('?', 2);
      path = rawPath;
      if (rawQuery !== undefined) {
        queryParams = new URLSearchParams(rawQuery.split('#', 1)[0]);
      }
    }

    if (path.includes('api-hub/')) {
      path = path.split('api-hub')[1] ?? '';
    }
  } catch {
    path = urlOrPath;
  }

  const pathSegments = path.split('/').filter((segment) => segment.length > 0);

  let project: string | undefined;
  let location: string | undefined;
  let apiId: string | undefined;
  let versionId: string | undefined;
  let specId: string | undefined;

  const projectIndex = pathSegments.indexOf('projects');
  if (projectIndex !== -1) {
    if (projectIndex + 1 < pathSegments.length) {
      project = pathSegments[projectIndex + 1];
    }
  } else if (queryParams?.has('project')) {
    project = queryParams.get('project') ?? undefined;
  }

  if (!project) {
    throw new Error(
      `Project ID not found in URL or path in APIHubClient. Input path is '${urlOrPath}'. Please make sure there is either '/projects/PROJECT_ID' in the path or 'project=PROJECT_ID' query param in the input.`,
    );
  }

  const locationIndex = pathSegments.indexOf('locations');
  if (locationIndex !== -1 && locationIndex + 1 < pathSegments.length) {
    location = pathSegments[locationIndex + 1];
  }
  if (!location) {
    throw new Error(
      `Location not found in URL or path in APIHubClient. Input path is '${urlOrPath}'. Please make sure there is either '/location/LOCATION_ID' in the path.`,
    );
  }

  const apiIndex = pathSegments.indexOf('apis');
  if (apiIndex !== -1 && apiIndex + 1 < pathSegments.length) {
    apiId = pathSegments[apiIndex + 1];
  }
  if (!apiId) {
    throw new Error(
      `API id not found in URL or path in APIHubClient. Input path is '${urlOrPath}'. Please make sure there is either '/apis/API_ID' in the path.`,
    );
  }

  const versionIndex = pathSegments.indexOf('versions');
  if (versionIndex !== -1 && versionIndex + 1 < pathSegments.length) {
    versionId = pathSegments[versionIndex + 1];
  }

  const specIndex = pathSegments.indexOf('specs');
  if (specIndex !== -1 && specIndex + 1 < pathSegments.length) {
    specId = pathSegments[specIndex + 1];
  }

  const apiResourceName = `projects/${project}/locations/${location}/apis/${apiId}`;
  const apiVersionResourceName = versionId
    ? `${apiResourceName}/versions/${versionId}`
    : undefined;
  const apiSpecResourceName =
    versionId && specId
      ? `${apiVersionResourceName}/specs/${specId}`
      : undefined;

  return [apiResourceName, apiVersionResourceName, apiSpecResourceName];
}

/**
 * Base class for API Hub clients.
 */
export abstract class BaseAPIHubClient {
  /**
   * Retrieves the specification content from API Hub for a given resource name or path.
   */
  abstract getSpecContent(resourceName: string): Promise<string> | string;
}

/**
 * Client for interacting with the Google Cloud API Hub service.
 */
export class APIHubClient extends BaseAPIHubClient {
  readonly rootUrl: string = API_HUB_ROOT_URL;
  credentialCache: CachedCredential | null = null;
  accessToken: string | null = null;
  serviceAccount: string | Record<string, unknown> | null = null;
  private readonly auth?: GoogleAuth;

  constructor(options: APIHubClientOptions = {}) {
    super();
    if (options.accessToken) {
      this.accessToken = options.accessToken;
    } else if (options.serviceAccountJson) {
      this.serviceAccount = options.serviceAccountJson;
    }
    this.auth = options.auth;
  }

  /**
   * Retrieves the specification content from the API Hub for a given resource path or UI URL.
   *
   * - If the path identifies `/apis/{api}`, fetches the first version and its first spec.
   * - If the path identifies `/apis/{api}/versions/{version}`, fetches the first spec of that version.
   * - If the path identifies `/apis/{api}/versions/{version}/specs/{spec}`, fetches that spec directly.
   *
   * @param path The resource name or Cloud Console UI URL for an API, API Version, or API Spec.
   * @returns The decoded specification content string.
   */
  override async getSpecContent(path: string): Promise<string> {
    const [apihubResourceName, initialVersionName, initialSpecName] =
      this.extractResourceName(path);
    let apiVersionResourceName = initialVersionName;
    let apiSpecResourceName = initialSpecName;

    if (apihubResourceName && !apiVersionResourceName) {
      const api = await this.getApi(apihubResourceName);
      const versions = Array.isArray(api.versions) ? api.versions : [];
      if (versions.length === 0) {
        throw new Error(
          `No versions found in API Hub resource: ${apihubResourceName}`,
        );
      }
      apiVersionResourceName = String(versions[0]);
    }

    if (apiVersionResourceName && !apiSpecResourceName) {
      const apiVersion = await this.getApiVersion(apiVersionResourceName);
      const specResourceNames = Array.isArray(apiVersion.specs)
        ? apiVersion.specs
        : [];
      if (specResourceNames.length === 0) {
        throw new Error(
          `No specs found in API Hub version: ${apiVersionResourceName}`,
        );
      }
      apiSpecResourceName = String(specResourceNames[0]);
    }

    if (apiSpecResourceName) {
      return this.fetchSpec(apiSpecResourceName);
    }

    throw new Error(`No API Hub resource found in path: ${path}`);
  }

  /**
   * Lists all APIs in the specified Google Cloud project and location.
   *
   * @param project The Google Cloud project ID.
   * @param location The API Hub location (for example, `'us-central1'`).
   * @returns A list of API metadata objects.
   */
  async listApis(
    project: string,
    location: string,
  ): Promise<Array<Record<string, unknown>>> {
    const url = `${this.rootUrl}/projects/${project}/locations/${location}/apis`;
    const headers = await this.createHeaders();
    const data = await this.sendGetRequest(url, headers);
    return Array.isArray(data.apis)
      ? (data.apis as Array<Record<string, unknown>>)
      : [];
  }

  /**
   * Gets API details by resource name.
   *
   * @param apiResourceName Resource name such as `projects/xxx/locations/us-central1/apis/apiname`.
   * @returns The API metadata dictionary.
   */
  async getApi(apiResourceName: string): Promise<Record<string, unknown>> {
    const url = `${this.rootUrl}/${apiResourceName}`;
    const headers = await this.createHeaders();
    return this.sendGetRequest(url, headers);
  }

  /**
   * Gets details of a specific API version.
   *
   * @param apiVersionName The resource name of the API version.
   * @returns The API version metadata dictionary.
   */
  async getApiVersion(
    apiVersionName: string,
  ): Promise<Record<string, unknown>> {
    const url = `${this.rootUrl}/${apiVersionName}`;
    const headers = await this.createHeaders();
    return this.sendGetRequest(url, headers);
  }

  /**
   * Retrieves and decodes the content of a specific API specification.
   *
   * @param apiSpecResourceName The resource name of the API spec.
   * @returns The UTF-8 decoded specification content, or an empty string if empty.
   */
  async fetchSpec(apiSpecResourceName: string): Promise<string> {
    const url = `${this.rootUrl}/${apiSpecResourceName}:contents`;
    const headers = await this.createHeaders();
    const data = await this.sendGetRequest(url, headers);
    const contentBase64 =
      typeof data.contents === 'string' ? data.contents : '';
    if (contentBase64) {
      return Buffer.from(contentBase64, 'base64').toString('utf-8');
    }
    return '';
  }

  /**
   * Extracts the resource names of an API, API Version, and API Spec from a URL or path.
   */
  extractResourceName(urlOrPath: string): ExtractedResourceNames {
    return extractResourceName(urlOrPath);
  }

  /**
   * Resolves the OAuth2 access token used for API Hub requests.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    if (this.credentialCache && !this.credentialCache.expired) {
      return this.credentialCache.token;
    }

    let parsedCredentials: Record<string, unknown> | undefined;
    if (this.serviceAccount) {
      if (typeof this.serviceAccount === 'string') {
        try {
          parsedCredentials = JSON.parse(this.serviceAccount) as Record<
            string,
            unknown
          >;
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          throw new Error(`Invalid service account JSON: ${message}`);
        }
      } else {
        parsedCredentials = this.serviceAccount;
      }
    }

    let token: string | null | undefined;
    try {
      const authInstance =
        this.auth ??
        new GoogleAuth({
          ...(parsedCredentials ? {credentials: parsedCredentials} : {}),
          scopes: [CLOUD_PLATFORM_SCOPE],
        });
      token = await authInstance.getAccessToken();
    } catch {
      token = null;
    }

    if (!token) {
      throw new Error(
        'Please provide a service account or an access token to API Hub client.',
      );
    }

    this.credentialCache = {
      token,
      expired: false,
    };
    return token;
  }

  private async createHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${token}`,
    };
  }

  private async sendGetRequest(
    url: string,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      throw new Error(
        `API Hub request failed with status ${response.status}: ${response.statusText}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

export {
  BaseAPIHubClient as BaseApiHubClient,
  APIHubClient as ApiHubClient,
  type APIHubClientOptions as ApiHubClientOptions,
};
