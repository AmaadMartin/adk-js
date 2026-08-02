/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SecretManagerServiceClient} from '@google-cloud/secret-manager';
import {GoogleAuth, JWT, JWTInput, OAuth2Client} from 'google-auth-library';
import {version} from '../../version.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const ADK_LIB_NAME = 'google-adk';

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

/**
 * Resolves the Secret Manager API endpoint for a region.
 *
 * Only the standard endpoint is supported. mTLS endpoint selection
 * (`secretmanager.{location}.rep.mtls.googleapis.com`) is not implemented, and
 * this is the single place that computes an endpoint.
 */
function resolveApiEndpoint(location: string): string {
  return `secretmanager.${location}.rep.googleapis.com`;
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
 * Builds the auth used by the generated client, in the same priority order as
 * the Python implementation: explicit service account key material, then an
 * existing access token, then Application Default Credentials.
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
  private readonly client: SecretManagerServiceClient;

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

    this.client = new SecretManagerServiceClient({
      auth: resolveAuth(options),
      libName: ADK_LIB_NAME,
      libVersion: version,
      ...(options.location
        ? {apiEndpoint: resolveApiEndpoint(options.location)}
        : {}),
    });
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
    const [response] = await this.client.accessSecretVersion({
      name: resourceName,
    });
    const data = response.payload?.data;
    if (data === undefined || data === null) {
      throw new Error(`Secret version ${resourceName} has no payload data.`);
    }
    return typeof data === 'string'
      ? data
      : Buffer.from(data).toString('utf-8');
  }
}
