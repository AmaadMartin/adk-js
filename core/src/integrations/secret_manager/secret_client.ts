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
const GLOBAL_HOST = 'secretmanager.googleapis.com';
/** Google Cloud location IDs hold only lowercase letters, digits and hyphens. */
const LOCATION_PATTERN = /^[a-z0-9-]+$/;

/** Options for {@link SecretManagerClient}. */
export interface SecretManagerClientOptions {
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
   * Google Cloud region for the Secret Manager regional endpoint. When
   * omitted, the global endpoint is used.
   */
  location?: string;
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
 * Builds the regional host for a location. The location reaches the hostname,
 * so a value holding a dot or a slash would send the request, and its bearer
 * token, to a host the caller did not intend.
 */
function regionalHost(location: string): string {
  if (!LOCATION_PATTERN.test(location)) {
    throw new InputValidationError(`Invalid location: ${location}`);
  }
  return `secretmanager.${location}.rep.googleapis.com`;
}

/**
 * Percent-encodes each segment of a resource name, keeping the `/` separators
 * the API expects. A raw name is not safe to interpolate: WHATWG URL parsing
 * reads an unencoded `#` as the start of a fragment, so the `:access` suffix
 * never reaches the wire and the read silently becomes a metadata call that
 * carries no payload.
 */
function encodeResourceName(resourceName: string): string {
  return resourceName.split('/').map(encodeURIComponent).join('/');
}

/**
 * Builds the auth in the same priority order as the Python implementation:
 * service account key material, then an existing access token, then
 * Application Default Credentials.
 */
function resolveAuth(options: SecretManagerClientOptions): GoogleAuth {
  if (options.serviceAccountJson) {
    return new GoogleAuth({
      credentials: parseServiceAccountJson(options.serviceAccountJson),
      scopes: CLOUD_PLATFORM_SCOPES,
    });
  }
  if (options.authToken) {
    const authClient = new OAuth2Client();
    authClient.setCredentials({access_token: options.authToken});
    return new GoogleAuth({authClient});
  }
  return new GoogleAuth({scopes: CLOUD_PLATFORM_SCOPES});
}

/**
 * A client for retrieving secrets from Google Cloud Secret Manager.
 *
 * Authentication uses the contents of a service account JSON key file, or a
 * preexisting authorization token, falling back to Application Default
 * Credentials when neither is provided.
 *
 * Only the standard endpoint is supported; the mTLS variant
 * (`secretmanager.{location}.rep.mtls.googleapis.com`) is not implemented.
 */
export class SecretManagerClient {
  private readonly auth: GoogleAuth;
  private readonly usesDefaultCredentials: boolean;
  private readonly host: string;

  /**
   * @throws {InputValidationError} If both `serviceAccountJson` and
   *   `authToken` are provided, if `serviceAccountJson` is not valid JSON, or
   *   if `location` is not a well-formed Google Cloud location ID.
   */
  constructor(options: SecretManagerClientOptions = {}) {
    if (options.serviceAccountJson && options.authToken) {
      throw new InputValidationError(
        "Must provide either 'serviceAccountJson' or 'authToken', not both.",
      );
    }

    this.usesDefaultCredentials =
      !options.serviceAccountJson && !options.authToken;
    this.auth = resolveAuth(options);
    this.host = options.location ? regionalHost(options.location) : GLOBAL_HOST;
  }

  /**
   * Retrieves a secret payload, decoded as UTF-8.
   *
   * Errors raised by the Secret Manager API (for example a missing secret or a
   * permission failure) propagate to the caller unchanged.
   *
   * @param resourceName The full resource name of the secret version, in the
   *   format `projects/{project}/secrets/{secret}/versions/{version}`, e.g.
   *   `projects/my-project/secrets/my-secret/versions/latest`. A regional
   *   secret carries a `locations/{location}` segment as well. Each segment is
   *   percent-encoded, so a name holding a URL metacharacter reaches the API as
   *   a literal and the API rejects it.
   */
  async getSecret(resourceName: string): Promise<string> {
    const client = await this.getAuthClient();
    // Proto3 JSON base64-encodes bytes, and omits an unset message field and a
    // default value alike, so an empty secret arrives with neither key.
    const response = await client.request<{payload?: {data?: string}}>({
      url: `https://${this.host}/v1/${encodeResourceName(resourceName)}:access`,
      headers: getTrackingHeaders(),
    });
    return base64Decode(response.data.payload?.data ?? '');
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
