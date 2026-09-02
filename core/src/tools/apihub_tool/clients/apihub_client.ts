/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, GoogleAuth, JWTInput} from 'google-auth-library';
import type {IncomingMessage} from 'node:http';
import * as https from 'node:https';
import {z} from 'zod';
import {base64Decode} from '../../../utils/env_aware_utils.js';
import {logger} from '../../../utils/logger.js';
import {
  effectiveGoogleapisEndpoint,
  loadDefaultClientCerts,
  MtlsClientCerts,
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

/** One HTTP response, as both transports below report it. */
interface HttpResponse {
  status: number;
  body: string;
}

const NON_OBJECT_MESSAGE = 'API Hub returned a non-object JSON response.';

/**
 * The message each field raises when it holds the wrong type.
 *
 * adk-python's `_response_object`, `_string_list` and `_object_list` raise
 * these strings verbatim, so they are part of the cross-SDK contract and
 * replace zod's own wording.
 */
const FIELD_MESSAGES: Record<string, string> = {
  apis: "API Hub field 'apis' must be a list of objects.",
  contents: "API Hub field 'contents' must be a string.",
  name: "API Hub field 'name' must be a string.",
  specs: "API Hub field 'specs' must be a list of strings.",
  versions: "API Hub field 'versions' must be a list of strings.",
};

const ApiSchema = z.object({
  name: z.string().optional(),
  versions: z.array(z.string()).optional(),
});

const ApiVersionSchema = z.object({
  name: z.string().optional(),
  specs: z.array(z.string()).optional(),
});

/**
 * The `apis.list` response. Its members only have to be objects, which is what
 * adk-python's `_object_list` requires; each one is then parsed with
 * {@link ApiSchema}, so a bad field names itself rather than the list.
 */
const ApiListSchema = z.object({
  apis: z.array(z.record(z.string(), z.unknown())).optional(),
});

const SpecContentsSchema = z.object({
  contents: z.string().optional(),
});

/**
 * Parses an API Hub payload, reporting the field that failed.
 *
 * A failure inside a field carries that field first in its path. A payload
 * that is not an object at all carries an empty path.
 */
function parsePayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }
  const field = result.error.issues[0]?.path[0];
  const message = typeof field === 'string' ? FIELD_MESSAGES[field] : undefined;
  throw new Error(message ?? NON_OBJECT_MESSAGE);
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
  try {
    return JSON.parse(serviceAccountJson) as JWTInput;
  } catch {
    throw new Error('Invalid service account JSON: the key is not valid JSON.');
  }
}

/** One GET over the global `fetch`, which presents no client certificate. */
async function getWithFetch(
  url: string,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {status: response.status, body: await response.text()};
}

/**
 * One GET presenting a client certificate.
 *
 * `globalThis.fetch` cannot present a client certificate in Node, which is why
 * this transport is `node:https`.
 */
function getWithClientCert(
  url: string,
  headers: Record<string, string>,
  certs: MtlsClientCerts,
): Promise<HttpResponse> {
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
      {
        method: 'GET',
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        agent: new https.Agent(certs),
      },
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

/** Reads APIs, API versions and API specs from the API Hub service. */
export class APIHubClient implements BaseAPIHubClient {
  private readonly accessToken?: string;
  private readonly serviceAccountJson?: string;
  private auth?: GoogleAuth;
  private certs?: Promise<MtlsClientCerts | undefined>;

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
    const {apis} = parsePayload(
      ApiListSchema,
      await this.get(
        `${APIHUB_ROOT_URL}/projects/${project}/locations/${location}/apis`,
      ),
    );
    return (apis ?? []).map((api) => parsePayload(ApiSchema, api));
  }

  /**
   * Gets an API.
   *
   * @param apiResourceName `projects/p/locations/l/apis/a`.
   */
  async getApi(apiResourceName: string): Promise<ApiHubApi> {
    return parsePayload(
      ApiSchema,
      await this.get(`${APIHUB_ROOT_URL}/${apiResourceName}`),
    );
  }

  /**
   * Gets an API version.
   *
   * @param apiVersionName `projects/p/locations/l/apis/a/versions/v`.
   */
  async getApiVersion(apiVersionName: string): Promise<ApiHubApiVersion> {
    return parsePayload(
      ApiVersionSchema,
      await this.get(`${APIHUB_ROOT_URL}/${apiVersionName}`),
    );
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
      if (versions.length === 0) {
        throw new Error(
          `No versions found in API Hub resource: ${names.apiResourceName}`,
        );
      }
      apiVersionResourceName = versions[0];
    }

    let apiSpecResourceName = names.apiSpecResourceName;
    if (!apiSpecResourceName) {
      const specs =
        (await this.getApiVersion(apiVersionResourceName)).specs ?? [];
      if (specs.length === 0) {
        throw new Error(
          `No specs found in API Hub version: ${apiVersionResourceName}`,
        );
      }
      apiSpecResourceName = specs[0];
    }

    const {contents} = parsePayload(
      SpecContentsSchema,
      await this.get(`${APIHUB_ROOT_URL}/${apiSpecResourceName}:contents`),
    );
    return contents ? base64Decode(contents) : '';
  }

  private async get(url: string): Promise<unknown> {
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'Authorization': `Bearer ${await this.getAccessToken()}`,
    };
    const certs = await this.clientCerts();
    const {status, body} = certs
      ? await getWithClientCert(
          effectiveGoogleapisEndpoint(url),
          headers,
          certs,
        )
      : await getWithFetch(url, headers);

    if (status < 200 || status > 299) {
      throw new Error(`API Hub request failed with status ${status}: ${body}`);
    }
    return JSON.parse(body);
  }

  /**
   * Returns the client certificate to present, or `undefined` when the
   * environment asks for none or none can be loaded.
   *
   * The certificate provider is a child process, so the load runs at most once
   * per client. A provider failure is a warning and falls back to the plain
   * transport, as adk-python's `configure_session_for_mtls` does.
   */
  private clientCerts(): Promise<MtlsClientCerts | undefined> {
    if (!useClientCertEffective()) {
      return Promise.resolve(undefined);
    }
    this.certs ??= loadDefaultClientCerts().catch((error: unknown) => {
      logger.warn(
        `Could not load a client certificate for API Hub, continuing without ` +
          `one: ${String(error)}`,
      );
      return undefined;
    });
    return this.certs;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }
    // google-auth-library caches the client and refreshes the token when it
    // expires.
    this.auth ??= this.createAuth();

    let client: AuthClient;
    try {
      client = await this.auth.getClient();
    } catch (e: unknown) {
      if (this.serviceAccountJson) {
        // A key was configured, so the fault is that key, not missing ADC.
        throw e;
      }
      throw new Error(NO_CREDENTIAL_MESSAGE, {cause: e});
    }

    const {token} = await client.getAccessToken();
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
