/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, GoogleAuth, OAuth2Client} from 'google-auth-library';
import {getClientLabels} from '../../utils/client_labels.js';
import {formatError} from '../../utils/error_utils.js';

const CLOUD_PLATFORM_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
];
const GLOBAL_HOST = 'secretmanager.googleapis.com';
const API_VERSION = 'v1';

/** The fields of `AccessSecretVersionResponse` this client reads. */
interface AccessSecretVersionResponse {
  /** Payload `data` is base64-encoded, as proto3 JSON encodes bytes. */
  payload: {data: string};
}

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

function parseServiceAccountJson(serviceAccountJson: string): object {
  try {
    return JSON.parse(serviceAccountJson) as object;
  } catch (e: unknown) {
    throw new Error(`Invalid service account JSON: ${formatError(e)}`);
  }
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
    return new GoogleAuth({authClient, scopes: CLOUD_PLATFORM_SCOPES});
  }
  return new GoogleAuth({scopes: CLOUD_PLATFORM_SCOPES});
}

/** Headers that identify this client to Google APIs. */
function trackingHeaders(): Record<string, string> {
  const labels = getClientLabels().join(' ');
  return {'x-goog-api-client': labels, 'user-agent': labels};
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
   * @throws If both `serviceAccountJson` and `authToken` are provided, or if
   *   `serviceAccountJson` is not valid JSON.
   */
  constructor(options: SecretManagerClientOptions = {}) {
    if (options.serviceAccountJson && options.authToken) {
      throw new Error(
        "Must provide either 'serviceAccountJson' or 'authToken', not both.",
      );
    }

    this.usesDefaultCredentials =
      !options.serviceAccountJson && !options.authToken;
    this.auth = resolveAuth(options);
    this.host = options.location
      ? `secretmanager.${options.location}.rep.googleapis.com`
      : GLOBAL_HOST;
  }

  /**
   * Retrieves a secret payload, decoded as UTF-8.
   *
   * Errors raised by the Secret Manager API (for example a missing secret or a
   * permission failure) propagate to the caller unchanged.
   *
   * @param resourceName The full resource name of the secret version, in the
   *   format `projects/*&#47;secrets/*&#47;versions/*`, e.g.
   *   `projects/my-project/secrets/my-secret/versions/latest`.
   */
  async getSecret(resourceName: string): Promise<string> {
    const client = await this.getAuthClient();
    const response = await client.request<AccessSecretVersionResponse>({
      url: `https://${this.host}/${API_VERSION}/${resourceName}:access`,
      headers: trackingHeaders(),
    });
    return Buffer.from(response.data.payload.data, 'base64').toString('utf-8');
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
      throw new Error(
        "'serviceAccountJson' or 'authToken' are both missing, and error " +
          `occurred while trying to use default credentials: ${formatError(e)}`,
      );
    }
  }
}
