/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, type JWTInput, OAuth2Client} from 'google-auth-library';
import {getClientLabels} from '../../utils/client_labels.js';

const CLOUD_PLATFORM_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
];
const GLOBAL_ENDPOINT = 'parametermanager.googleapis.com';

/** Subset of the Parameter Manager `RenderParameterVersionResponse` used here. */
interface RenderParameterVersionResponse {
  /** The rendered payload, base64 encoded as a proto3 JSON `bytes` field. */
  renderedPayload?: string;
}

/** Options for {@link ParameterManagerClient}. */
export interface ParameterManagerClientOptions {
  /**
   * The content of a service account JSON keyfile, not the file path. Must be
   * valid JSON. Mutually exclusive with {@link authToken}.
   */
  serviceAccountJson?: string;
  /**
   * An existing Google Cloud authorization token, used as-is and never
   * refreshed. Mutually exclusive with {@link serviceAccountJson}.
   */
  authToken?: string;
  /**
   * The Google Cloud location (region) to use for the Parameter Manager
   * service. If not provided, the global endpoint is used.
   */
  location?: string;
}

/**
 * Resolves the regional Parameter Manager endpoint for a location.
 *
 * adk-js has no mTLS support yet, so only the standard endpoint is selected
 * here. This is the single seam where the mTLS variant
 * (`parametermanager.{location}.rep.mtls.googleapis.com`) will be chosen once a
 * shared mTLS endpoint utility exists.
 */
function regionalEndpoint(location: string): string {
  return `parametermanager.${location}.rep.googleapis.com`;
}

/**
 * Builds the render URL, percent-encoding each resource name segment so a
 * caller-supplied name cannot inject a query string or extra path segments.
 */
function renderUrl(endpoint: string, resourceName: string): string {
  const name = resourceName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://${endpoint}/v1/${name}:render`;
}

function parseServiceAccountJson(serviceAccountJson: string): JWTInput {
  try {
    return JSON.parse(serviceAccountJson) as JWTInput;
  } catch (e: unknown) {
    // The input is credential material, so only the parser's message is
    // surfaced.
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid service account JSON: ${message}`);
  }
}

function createAuth(options: ParameterManagerClientOptions): GoogleAuth {
  if (options.serviceAccountJson) {
    return new GoogleAuth({
      credentials: parseServiceAccountJson(options.serviceAccountJson),
      scopes: CLOUD_PLATFORM_SCOPES,
    });
  }
  if (options.authToken) {
    const authClient = new OAuth2Client();
    authClient.setCredentials({access_token: options.authToken});
    return new GoogleAuth({authClient, scopes: CLOUD_PLATFORM_SCOPES});
  }
  return new GoogleAuth({scopes: CLOUD_PLATFORM_SCOPES});
}

/**
 * A client for interacting with Google Cloud Parameter Manager.
 *
 * This class provides a simplified interface for retrieving parameters from
 * Parameter Manager, handling authentication using either a service account
 * JSON keyfile (passed as a string), a preexisting authorization token, or
 * Application Default Credentials.
 */
export class ParameterManagerClient {
  private readonly auth: GoogleAuth;
  private readonly endpoint: string;

  /**
   * Initializes the ParameterManagerClient.
   *
   * If neither `serviceAccountJson` nor `authToken` is provided, Application
   * Default Credentials are used.
   *
   * @throws If both `serviceAccountJson` and `authToken` are provided, or if
   *     `serviceAccountJson` is not valid JSON.
   */
  constructor(options: ParameterManagerClientOptions = {}) {
    if (options.serviceAccountJson && options.authToken) {
      throw new Error(
        "Must provide either 'serviceAccountJson' or 'authToken', not both.",
      );
    }
    this.auth = createAuth(options);
    this.endpoint = options.location
      ? regionalEndpoint(options.location)
      : GLOBAL_ENDPOINT;
  }

  /**
   * Retrieves a rendered parameter value from Google Cloud Parameter Manager.
   *
   * When neither credential option was supplied, Application Default
   * Credentials are resolved on the first call, so an unresolvable ADC
   * environment surfaces here rather than from the constructor.
   *
   * @param resourceName The full resource name of the parameter version, in the
   *     format `projects/*\/locations/*\/parameters/*\/versions/*`. Usually you
   *     want the `latest` version, e.g.
   *     `projects/my-project/locations/global/parameters/my-param/versions/latest`.
   * @return The rendered parameter value as a UTF-8 string.
   * @throws If the Parameter Manager API returns an error (e.g. parameter not
   *     found, permission denied).
   */
  async getParameter(resourceName: string): Promise<string> {
    const client = await this.auth.getClient();
    const {data} = await client.request<RenderParameterVersionResponse>({
      url: renderUrl(this.endpoint, resourceName),
      headers: {'x-goog-api-client': getClientLabels().join(' ')},
    });
    return Buffer.from(data.renderedPayload ?? '', 'base64').toString('utf-8');
  }
}
