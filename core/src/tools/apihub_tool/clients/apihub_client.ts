/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient} from 'google-auth-library';
import {experimental} from '../../../utils/experimental.js';
import {
  parseServiceAccountJson,
  resolveGoogleAuthClient,
} from '../../../utils/google_auth_utils.js';

/** The API Hub v1 REST endpoint. */
const API_HUB_ROOT_URL = 'https://apihub.googleapis.com/v1';

/** The `accept` header value API Hub is called with. */
const ACCEPT_HEADER = 'application/json, text/plain, */*';

/** Thrown when the client holds no usable credential. */
const NO_CREDENTIALS_MESSAGE =
  'Please provide a service account or an access token to API Hub client.';

/** An API, as returned by the API Hub `apis` endpoints. */
export interface ApiHubApi {
  name?: string;
  versions?: string[];
}

/** One version of an API, as returned by the API Hub versions endpoint. */
export interface ApiHubApiVersion {
  name?: string;
  specs?: string[];
}

/** The resource names a path resolves to. */
export interface ApiHubResourceNames {
  apiResourceName: string;
  apiVersionResourceName?: string;
  apiSpecResourceName?: string;
}

/** Options for {@link APIHubClient}. */
export interface APIHubClientOptions {
  /**
   * A bearer token, sent verbatim. Generate one with
   * `gcloud auth print-access-token`. Takes precedence over every other
   * option.
   */
  accessToken?: string;
  /**
   * Service account key material, as the JSON **string** read from the key
   * file. Used when `accessToken` is absent.
   */
  serviceAccountJson?: string;
}

/** Base class for API Hub clients. */
@experimental
export abstract class BaseAPIHubClient {
  /** Returns the specification registered under `resourceName`. */
  abstract getSpecContent(resourceName: string): Promise<string>;
}

/** Client for the API Hub service. */
@experimental
export class APIHubClient extends BaseAPIHubClient {
  private readonly accessToken?: string;
  private readonly serviceAccountJson?: string;
  private credentialCache?: AuthClient;

  constructor(options: APIHubClientOptions = {}) {
    super();
    this.accessToken = options.accessToken;
    this.serviceAccountJson = options.serviceAccountJson;
  }

  /**
   * Resolves `path` to a single specification and returns its decoded text.
   *
   * A path pinned at the API level resolves to the first version and then the
   * first specification of that version. A path pinned at the version level
   * resolves to the first specification. A path pinned at the specification
   * level is fetched directly.
   *
   * @param path An API Hub resource name or a Cloud console URL.
   * @returns The specification text, or an empty string when the
   *     specification has no contents.
   */
  override async getSpecContent(path: string): Promise<string> {
    const {apiResourceName, apiVersionResourceName, apiSpecResourceName} =
      extractResourceName(path);

    let versionName = apiVersionResourceName;
    if (!versionName) {
      const api = await this.getApi(apiResourceName);
      const versions = api.versions ?? [];
      if (versions.length === 0) {
        throw new Error(
          `No versions found in API Hub resource: ${apiResourceName}`,
        );
      }
      versionName = versions[0];
    }

    let specName = apiSpecResourceName;
    if (!specName) {
      const version = await this.getApiVersion(versionName);
      const specs = version.specs ?? [];
      if (specs.length === 0) {
        throw new Error(`No specs found in API Hub version: ${versionName}`);
      }
      specName = specs[0];
    }

    return this.fetchSpec(specName);
  }

  /** Lists the APIs registered in `project` and `location`. */
  async listApis(project: string, location: string): Promise<ApiHubApi[]> {
    const {apis} = await this.get<{apis?: ApiHubApi[]}>(
      `${API_HUB_ROOT_URL}/projects/${project}/locations/${location}/apis`,
    );
    return apis ?? [];
  }

  /** Gets one API by its resource name. */
  async getApi(apiResourceName: string): Promise<ApiHubApi> {
    return this.get<ApiHubApi>(`${API_HUB_ROOT_URL}/${apiResourceName}`);
  }

  /** Gets one API version by its resource name. */
  async getApiVersion(apiVersionName: string): Promise<ApiHubApiVersion> {
    return this.get<ApiHubApiVersion>(`${API_HUB_ROOT_URL}/${apiVersionName}`);
  }

  private async fetchSpec(apiSpecResourceName: string): Promise<string> {
    const {contents} = await this.get<{contents?: string}>(
      `${API_HUB_ROOT_URL}/${apiSpecResourceName}:contents`,
    );
    return contents ? Buffer.from(contents, 'base64').toString('utf-8') : '';
  }

  private async get<T>(url: string): Promise<T> {
    const response = await globalThis.fetch(url, {
      headers: {
        accept: ACCEPT_HEADER,
        Authorization: `Bearer ${await this.getAccessToken()}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `API Hub request failed with status ${response.status}: ` +
          `${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }
    this.credentialCache ??= await loadCredentials(this.serviceAccountJson);

    const {token} = await this.credentialCache.getAccessToken();
    if (!token) {
      throw new Error(NO_CREDENTIALS_MESSAGE);
    }
    return token;
  }
}

/**
 * Extracts the API, API version, and API specification resource names from a
 * resource path or a Cloud console URL.
 *
 * The version name is returned only when the input names a version, and the
 * specification name only when the input names both a version and a
 * specification.
 *
 * @throws Error when the input names no project, no location, or no API.
 */
export function extractResourceName(urlOrPath: string): ApiHubResourceNames {
  const {path, query} = splitQuery(urlOrPath);
  const segments = stripConsolePrefix(path)
    .split('/')
    .filter((segment) => segment);

  // The query parameter is a fallback for a console URL, which carries the
  // project there rather than in the path. It matches adk-python, which reads
  // it only when the path has no `projects` segment at all.
  const project = segments.includes('projects')
    ? segmentAfter(segments, 'projects')
    : query.get('project');
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
  const apiSpecResourceName =
    apiVersionResourceName && specId
      ? `${apiVersionResourceName}/specs/${specId}`
      : undefined;

  return {apiResourceName, apiVersionResourceName, apiSpecResourceName};
}

/**
 * Splits an input into its path part and its parsed query string.
 *
 * `new URL` is not used here: it rejects a bare resource name, and giving it a
 * base percent-encodes the path, which would alter an API id.
 */
function splitQuery(urlOrPath: string): {path: string; query: URLSearchParams} {
  const [path, ...query] = urlOrPath.split('?');
  return {path, query: new URLSearchParams(query.join('?'))};
}

/** Drops everything up to and including `api-hub` from a console URL. */
function stripConsolePrefix(path: string): string {
  return path.includes('api-hub/') ? path.split('api-hub')[1] : path;
}

/** Returns the segment after `key`, or undefined when `key` is absent or last. */
function segmentAfter(segments: string[], key: string): string | undefined {
  const index = segments.indexOf(key);
  return index === -1 ? undefined : segments[index + 1];
}

/**
 * Resolves the credential the client signs with.
 *
 * Key material the caller supplied reports its own failure, and a failure to
 * resolve Application Default Credentials is reported as a missing
 * credential, which is what adk-python does.
 */
async function loadCredentials(
  serviceAccountJson?: string,
): Promise<AuthClient> {
  if (serviceAccountJson) {
    return resolveGoogleAuthClient(parseServiceAccountJson(serviceAccountJson));
  }
  try {
    return await resolveGoogleAuthClient();
  } catch (e) {
    throw new Error(NO_CREDENTIALS_MESSAGE, {cause: e});
  }
}
