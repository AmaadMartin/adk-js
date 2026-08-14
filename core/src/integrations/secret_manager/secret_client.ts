/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {JWTInput} from 'google-auth-library';
import {GoogleAuth, JWT, OAuth2Client} from 'google-auth-library';
import {version} from '../../version.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const GLOBAL_HOST = 'secretmanager.googleapis.com';

/** The fields of `AccessSecretVersionResponse` this client reads. */
interface AccessSecretVersionResponse {
  /** Payload `data` is base64-encoded, as proto3 JSON encodes bytes. */
  payload?: {data?: string};
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
   * omitted, the global endpoint is used. Only the standard endpoint is
   * supported; the mTLS variant
   * (`secretmanager.{location}.rep.mtls.googleapis.com`) is not ported.
   */
  location?: string;
}

function parseServiceAccountJson(serviceAccountJson: string): JWTInput {
  try {
    return JSON.parse(serviceAccountJson);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid service account JSON: ${message}`);
  }
}

/**
 * Builds the auth used by the client, in the same priority order as the Python
 * implementation: explicit service account key material, then an existing
 * access token, then Application Default Credentials.
 *
 * Application Default Credentials are resolved lazily on first use, so an
 * unresolvable ADC environment surfaces on the first
 * {@link SecretManagerClient.getSecret} call rather than at construction time.
 */
function resolveAuth(options: SecretManagerClientOptions): GoogleAuth {
  if (options.serviceAccountJson) {
    const jwt = new JWT({scopes: DEFAULT_SCOPES});
    jwt.fromJSON(parseServiceAccountJson(options.serviceAccountJson));
    return new GoogleAuth({authClient: jwt, scopes: DEFAULT_SCOPES});
  }
  if (options.authToken) {
    const oauth = new OAuth2Client();
    oauth.setCredentials({access_token: options.authToken});
    return new GoogleAuth({authClient: oauth, scopes: DEFAULT_SCOPES});
  }
  return new GoogleAuth({scopes: DEFAULT_SCOPES});
}

/**
 * A client for retrieving secrets from Google Cloud Secret Manager.
 *
 * Authentication uses the contents of a service account JSON key file, or a
 * preexisting authorization token, falling back to Application Default
 * Credentials when neither is provided.
 */
export class SecretManagerClient {
  private readonly auth: GoogleAuth;
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
    const client = await this.auth.getClient();
    const response = await client.request<AccessSecretVersionResponse>({
      url: `https://${this.host}/v1/${resourceName}:access`,
      headers: {'User-Agent': `google-adk/${version}`},
    });
    const data = response.data.payload?.data;
    if (data == null) {
      throw new Error(`Secret version ${resourceName} has no payload data.`);
    }
    return Buffer.from(data, 'base64').toString('utf-8');
  }
}
