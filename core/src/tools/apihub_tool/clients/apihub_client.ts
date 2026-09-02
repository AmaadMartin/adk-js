/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWTInput} from 'google-auth-library';
import {IncomingMessage} from 'node:http';
import * as https from 'node:https';
import {base64Decode} from '../../../utils/env_aware_utils.js';
import {formatError} from '../../../utils/error_utils.js';
import {logger} from '../../../utils/logger.js';
import {
  MtlsClientCerts,
  effectiveGoogleapisEndpoint,
  loadDefaultClientCerts,
  useClientCertEffective,
} from '../../../utils/mtls_utils.js';

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
  /** The version resource name, when the path names a version. */
  apiVersionResourceName?: string;
  /** The spec resource name, when the path names a version and a spec. */
  apiSpecResourceName?: string;
}

/** An API Hub API resource, as far as this client reads it. */
export interface ApiHubApi {
  /** The resource name of the API. */
  name?: string;
  /** The resource names of the API's versions. */
  versions?: string[];
}

/** An API Hub API version resource, as far as this client reads it. */
export interface ApiHubApiVersion {
  /** The resource name of the version. */
  name?: string;
  /** The resource names of the version's specs. */
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

/** The status and body of one API Hub response, on either transport. */
interface ApiHubResponse {
  status: number;
  body: string;
}

/** Reports whether a value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates that an API Hub response body is a JSON object.
 *
 * The declared fields of a response are a view over untrusted input, so the
 * client validates each field where it reads it. This is the outer check the
 * views themselves rest on.
 *
 * @throws If the body decoded to an array, a string, a number, a boolean or
 *     `null`.
 */
function requireJsonObject(payload: unknown): void {
  if (!isRecord(payload)) {
    throw new Error('API Hub returned a non-object JSON response.');
  }
}

/**
 * Validates an API Hub field that must be an array of strings.
 *
 * @throws If the field holds anything else.
 */
function requireStringList(value: unknown, field: string): void {
  const isStringList =
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string');
  if (!isStringList) {
    throw new Error(`API Hub field '${field}' must be a list of strings.`);
  }
}

/**
 * Validates an API Hub field that must be an array of JSON objects.
 *
 * @throws If the field holds anything else.
 */
function requireObjectList(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`API Hub field '${field}' must be a list of objects.`);
  }
}

/**
 * Validates an API Hub field that must be a string when it is present.
 *
 * @throws If the field is present and holds anything else.
 */
function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`API Hub field '${field}' must be a string.`);
  }
}

/**
 * Loads the client certificate to present, when the environment asks for one.
 *
 * A machine with no certificate, and a certificate that cannot be loaded, both
 * resolve to `undefined`: the caller then connects without one, because a
 * mutual-TLS host rejects a connection that presents nothing.
 */
async function clientCertsToPresent(): Promise<MtlsClientCerts | undefined> {
  if (!useClientCertEffective()) {
    return undefined;
  }
  try {
    return await loadDefaultClientCerts();
  } catch (error: unknown) {
    logger.warn(
      'Calling API Hub without a client certificate, because it could not ' +
        `be loaded: ${formatError(error)}`,
    );
    return undefined;
  }
}

/** One authenticated GET over `globalThis.fetch`. */
async function getWithFetch(
  url: string,
  headers: Record<string, string>,
): Promise<ApiHubResponse> {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {status: response.status, body: await response.text()};
}

/**
 * One authenticated GET that presents a client certificate.
 *
 * `globalThis.fetch` cannot present a client certificate in Node, which is why
 * this transport is `node:https`.
 */
function getWithClientCert(
  url: string,
  headers: Record<string, string>,
  certs: MtlsClientCerts,
): Promise<ApiHubResponse> {
  return new Promise((resolve, reject) => {
    const collect = (response: IncomingMessage) => {
      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('error', reject);
      response.on('end', () => {
        resolve({status: response.statusCode ?? 0, body});
      });
    };

    const request = https.request(
      url,
      {headers, timeout: REQUEST_TIMEOUT_MS, agent: new https.Agent(certs)},
      collect,
    );
    // A timeout only fires the event; the request stays open until destroyed.
    request.on('timeout', () => {
      request.destroy(
        new Error(
          `API Hub request timed out after ${REQUEST_TIMEOUT_MS} ms: ${url}`,
        ),
      );
    });
    request.on('error', reject);
    request.end();
  });
}

/** Returns the segment that follows `keyword`, if the path has one. */
function segmentAfter(segments: string[], keyword: string): string | undefined {
  const index = segments.indexOf(keyword);
  return index === -1 ? undefined : segments[index + 1];
}

/** Splits an input into its path and its `project` query parameter. */
function splitPathAndProject(urlOrPath: string): {
  path: string;
  queryProject?: string;
} {
  try {
    const url = new URL(urlOrPath, 'http://localhost');
    return {
      path: url.pathname,
      queryProject: url.searchParams.get('project') ?? undefined,
    };
  } catch {
    return {path: urlOrPath};
  }
}

/**
 * Extracts the API, API version and API spec resource names from an API Hub
 * path or Cloud Console URL.
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
  // The segment walk below ignores any Console UI route prefix on its own, so
  // the path needs no stripping. adk-python strips everything before
  // 'api-hub/', which corrupts a resource path whose API id is 'api-hub'.
  const segments = path.split('/').filter((segment) => segment !== '');

  const project = segmentAfter(segments, 'projects') ?? queryProject;
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

/**
 * Parses a service account key.
 *
 * The parser message quotes the offending input, so it would print key
 * material into an error a user may share. The thrown message therefore names
 * the failure only.
 */
function parseServiceAccountJson(serviceAccountJson: string): JWTInput {
  let credentials: JWTInput;
  try {
    credentials = JSON.parse(serviceAccountJson) as JWTInput;
  } catch {
    throw new Error('Invalid service account JSON: the key is not valid JSON.');
  }
  if (!isRecord(credentials)) {
    throw new Error('Service account JSON must contain an object.');
  }
  return credentials;
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
   * Lists all APIs in the given project and location.
   *
   * @param project The Google Cloud project name.
   * @param location The location of the API Hub resources, e.g. 'us-central1'.
   * @returns The APIs, or an empty list when the project has none.
   */
  async listApis(project: string, location: string): Promise<ApiHubApi[]> {
    const list = await this.get<ApiHubApiList>(
      `${APIHUB_ROOT_URL}/projects/${project}/locations/${location}/apis`,
    );
    const apis = list.apis ?? [];
    requireObjectList(apis, 'apis');
    return apis;
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
   * @param path An API Hub resource path or Cloud Console URL.
   * @returns The spec, or an empty string when the spec has no content.
   */
  async getSpecContent(path: string): Promise<string> {
    const names = extractResourceName(path);

    let apiVersionResourceName = names.apiVersionResourceName;
    if (!apiVersionResourceName) {
      const versions =
        (await this.getApi(names.apiResourceName)).versions ?? [];
      requireStringList(versions, 'versions');
      if (versions.length === 0) {
        throw new Error(
          `No versions found in API Hub resource: ${names.apiResourceName}`,
        );
      }
      apiVersionResourceName = versions[0];
    }

    let apiSpecResourceName = names.apiSpecResourceName;
    if (apiVersionResourceName && !apiSpecResourceName) {
      const specs =
        (await this.getApiVersion(apiVersionResourceName)).specs ?? [];
      requireStringList(specs, 'specs');
      if (specs.length === 0) {
        throw new Error(
          `No specs found in API Hub version: ${apiVersionResourceName}`,
        );
      }
      apiSpecResourceName = specs[0];
    }

    if (!apiSpecResourceName) {
      throw new Error(`No API Hub resource found in path: ${path}`);
    }

    const {contents} = await this.get<ApiHubSpecContents>(
      `${APIHUB_ROOT_URL}/${apiSpecResourceName}:contents`,
    );
    requireOptionalString(contents, 'contents');
    return contents ? base64Decode(contents) : '';
  }

  /**
   * Sends one authenticated GET to API Hub.
   *
   * A configured client certificate is presented on the connection, and the
   * request then goes to the mutual-TLS endpoint so that token binding is
   * honoured. Without a certificate the host stays as it is: the mutual-TLS
   * host rejects a connection that presents none.
   */
  private async get<T>(url: string): Promise<T> {
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'Authorization': `Bearer ${await this.getAccessToken()}`,
    };

    const certs = await clientCertsToPresent();
    const {status, body} = certs
      ? await getWithClientCert(
          effectiveGoogleapisEndpoint(url),
          headers,
          certs,
        )
      : await getWithFetch(url, headers);

    if (status < 200 || status >= 300) {
      throw new Error(`API Hub request failed with status ${status}: ${body}`);
    }
    const payload = JSON.parse(body) as T;
    requireJsonObject(payload);
    return payload;
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
