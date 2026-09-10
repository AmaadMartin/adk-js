/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthClient,
  GoogleAuth,
  JWTInput,
  OAuth2Client,
} from 'google-auth-library';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {getTrackingHeaders} from '../../utils/client_labels.js';
import {base64Decode} from '../../utils/env_aware_utils.js';
import {formatError} from '../../utils/error_utils.js';

const CLOUD_PLATFORM_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
];
const GLOBAL_HOST = 'parametermanager.googleapis.com';
const API_VERSION = 'v1';
const REGIONAL_HOST_TEMPLATE = 'parametermanager.{location}.rep.googleapis.com';
/** Google Cloud location IDs hold only lowercase letters, digits and hyphens. */
const LOCATION_PATTERN = /^[a-z0-9-]+$/;
/**
 * A parameter version resource name. Unlike a Secret Manager name it always
 * carries a `locations/{location}` segment; a global parameter uses the
 * literal `global`. Each segment excludes `/`, `?` and `#`, which the name
 * would otherwise carry into the request URL.
 */
const RESOURCE_NAME_PATTERN =
  /^projects\/[^/?#]+\/locations\/[^/?#]+\/parameters\/[^/?#]+\/versions\/[^/?#]+$/;

/** The `:render` response. Proto3 JSON base64-encodes a bytes field. */
interface RenderParameterVersionResponse {
  renderedPayload?: string;
}

/** Options for {@link ParameterManagerClient}. */
export interface ParameterManagerClientOptions {
  /**
   * The *contents* of a service account JSON key file, as a string — not a
   * file path. Mutually exclusive with `authToken`.
   */
  serviceAccountJson?: string;
  /**
   * An existing Google Cloud access token, used as-is and never refreshed.
   * Mutually exclusive with `serviceAccountJson`.
   */
  authToken?: string;
  /**
   * Google Cloud region for the Parameter Manager regional endpoint. When
   * omitted, the global endpoint is used.
   */
  location?: string;
}

/**
 * Builds the host to call. The location reaches the hostname, so a value
 * holding a dot or a slash would send the request, and its bearer token, to a
 * host the caller did not intend.
 */
function resolveHost(location?: string): string {
  if (!location) {
    return GLOBAL_HOST;
  }
  if (!LOCATION_PATTERN.test(location)) {
    throw new InputValidationError(`Invalid location: ${location}`);
  }
  // The replacement is a function so a `$&` in the location cannot expand.
  return REGIONAL_HOST_TEMPLATE.replace('{location}', () => location);
}

function parseServiceAccountJson(serviceAccountJson: string): JWTInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch (e: unknown) {
    throw new InputValidationError(
      `Invalid service account JSON: ${formatError(e)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InputValidationError(
      'Invalid service account JSON: expected a JSON object.',
    );
  }
  return parsed;
}

/**
 * Builds the auth in the same priority order as the Python implementation:
 * service account key material, then an existing access token, then
 * Application Default Credentials.
 */
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
 * A client for retrieving parameters from Google Cloud Parameter Manager.
 *
 * Authentication uses the contents of a service account JSON key file, or a
 * preexisting authorization token, falling back to Application Default
 * Credentials when neither is provided.
 *
 * Only the standard endpoint is supported; the mutual-TLS variant
 * (`parametermanager.{location}.rep.mtls.googleapis.com`) is not implemented.
 */
export class ParameterManagerClient {
  private readonly auth: GoogleAuth;
  private readonly usesDefaultCredentials: boolean;
  private readonly host: string;

  /**
   * @throws {InputValidationError} If both `serviceAccountJson` and
   *   `authToken` are provided, if `serviceAccountJson` is not valid JSON, or
   *   if `location` is not a well-formed Google Cloud location ID.
   */
  constructor(options: ParameterManagerClientOptions = {}) {
    if (options.serviceAccountJson && options.authToken) {
      throw new InputValidationError(
        "Must provide either 'serviceAccountJson' or 'authToken', not both.",
      );
    }

    this.usesDefaultCredentials =
      !options.serviceAccountJson && !options.authToken;
    this.host = resolveHost(options.location);
    this.auth = createAuth(options);
  }

  /**
   * Renders a parameter version and returns its payload, decoded as UTF-8.
   *
   * Errors raised by the Parameter Manager API (for example a missing
   * parameter or a permission failure) propagate to the caller unchanged.
   *
   * @param resourceName The full resource name of the parameter version, in
   *   the format `projects/{project}/locations/{location}/parameters/{parameter}/versions/{version}`,
   *   e.g. `projects/my-project/locations/global/parameters/my-param/versions/latest`.
   * @throws {InputValidationError} If `resourceName` is not a full resource
   *   name. The name reaches the request path, so a value holding `?` or `#`
   *   would retarget the call.
   */
  async getParameter(resourceName: string): Promise<string> {
    if (!RESOURCE_NAME_PATTERN.test(resourceName)) {
      throw new InputValidationError(
        `Invalid parameter resource name: ${resourceName}. Expected ` +
          '"projects/*/locations/*/parameters/*/versions/*".',
      );
    }
    const client = await this.getAuthClient();
    // Proto3 JSON omits an unset bytes field and an empty one alike, so an
    // empty parameter arrives with no key.
    const {data} = await client.request<RenderParameterVersionResponse>({
      url: `https://${this.host}/${API_VERSION}/${resourceName}:render`,
      headers: getTrackingHeaders(),
    });
    return base64Decode(data.renderedPayload ?? '');
  }

  /**
   * Resolves the auth client, minting a token on first use. Application
   * Default Credentials are resolved here rather than in the constructor,
   * which cannot await.
   */
  private async getAuthClient(): Promise<AuthClient> {
    try {
      return await this.auth.getClient();
    } catch (e: unknown) {
      if (!this.usesDefaultCredentials) {
        throw e;
      }
      throw new InputValidationError(
        "'serviceAccountJson' or 'authToken' are both missing, and error " +
          `occurred while trying to use default credentials: ${formatError(e)}`,
      );
    }
  }
}
