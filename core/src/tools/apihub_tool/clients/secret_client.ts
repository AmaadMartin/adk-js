/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A port of adk-python `v0.1.0`
 * `tools/apihub_tool/clients/secret_client.py`, which is the path that
 * release keeps the client at. A later adk-python release moved the class to
 * `integrations/secret_manager/` and left a deprecating re-export behind. That
 * move postdates `v0.1.0`, so it is not part of this port.
 */

import {AuthClient, JWTInput} from 'google-auth-library';
import {formatError} from '../../../utils/error_utils.js';
import {
  parseServiceAccountJson,
  resolveGoogleAuthClient,
} from '../../../utils/google_auth_utils.js';

/** Root of the Secret Manager REST service. */
const SECRET_MANAGER_BASE_URL = 'https://secretmanager.googleapis.com';

/**
 * The part of Secret Manager's `AccessSecretVersionResponse` this client
 * reads. `payload.data` is declared `format: byte`, so it holds base64.
 */
interface AccessSecretVersionResponse {
  payload: {data: string};
}

/** How {@link SecretManagerClient} authenticates to Secret Manager. */
export interface SecretManagerClientOptions {
  /**
   * The contents of a service account JSON keyfile, as a string. This is the
   * keyfile itself, not a path to it.
   */
  serviceAccountJson?: string;
  /** An existing Google Cloud OAuth 2.0 access token. */
  authToken?: string;
}

/**
 * Resolves an authenticated client from a service account keyfile, or from
 * Application Default Credentials when `serviceAccount` is omitted.
 *
 * A keyfile failure propagates unchanged, because the caller supplied the
 * credential and the library's own message describes what is wrong with it.
 */
async function resolveAuthClient(
  serviceAccount?: JWTInput,
): Promise<AuthClient> {
  try {
    return await resolveGoogleAuthClient(serviceAccount);
  } catch (error: unknown) {
    if (serviceAccount) {
      throw error;
    }
    throw new Error(
      "'serviceAccountJson' or 'authToken' are both missing, and error " +
        'occurred while trying to use default credentials: ' +
        formatError(error),
    );
  }
}

/**
 * Reads secret values from Google Cloud Secret Manager.
 *
 * The client authenticates in one of three ways: from the contents of a
 * service account JSON keyfile, from an existing OAuth 2.0 access token, or —
 * when neither is supplied — from Application Default Credentials.
 *
 * The value {@link SecretManagerClient.getSecret} returns is credential
 * material. Pass it to the component that needs it, and keep it out of logs,
 * artifacts and model prompts.
 */
export class SecretManagerClient {
  private readonly authToken?: string;
  private readonly serviceAccount?: JWTInput;
  /**
   * The authenticated client, resolved on first use and reused afterwards. A
   * TypeScript constructor cannot await, so a credential problem surfaces
   * from the first {@link SecretManagerClient.getSecret} call.
   */
  private authClient?: Promise<AuthClient>;

  /**
   * @param options The credential source. Supplying both `serviceAccountJson`
   *   and `authToken` throws, because the client cannot tell which one the
   *   caller meant to use.
   * @throws If both credentials are supplied, or if `serviceAccountJson` is
   *   not valid JSON.
   */
  constructor(options: SecretManagerClientOptions = {}) {
    const {serviceAccountJson, authToken} = options;
    if (serviceAccountJson && authToken) {
      throw new Error(
        "Must provide either 'serviceAccountJson' or 'authToken', not both.",
      );
    }
    this.authToken = authToken;
    if (serviceAccountJson) {
      this.serviceAccount = parseServiceAccountJson(serviceAccountJson);
    }
  }

  private async requestHeaders(): Promise<Headers> {
    if (this.authToken) {
      return new Headers({Authorization: `Bearer ${this.authToken}`});
    }
    const client = await (this.authClient ??= resolveAuthClient(
      this.serviceAccount,
    ));
    return client.getRequestHeaders(SECRET_MANAGER_BASE_URL);
  }

  /**
   * Reads the payload of a secret version.
   *
   * @param resourceName The full version resource name, in the form
   *   `projects/*\/secrets/*\/versions/*`. `versions/latest` reads the most
   *   recent enabled version.
   * @return The secret payload, decoded as a UTF-8 string.
   * @throws If credentials cannot be resolved, or if Secret Manager answers
   *   with a non-2xx status.
   */
  async getSecret(resourceName: string): Promise<string> {
    const response = await fetch(
      `${SECRET_MANAGER_BASE_URL}/v1/${resourceName}:access`,
      {headers: await this.requestHeaders()},
    );
    if (!response.ok) {
      throw new Error(
        `Failed to access secret version '${resourceName}': ` +
          `${response.status} ${await response.text()}`,
      );
    }
    const {payload} = (await response.json()) as AccessSecretVersionResponse;
    return Buffer.from(payload.data, 'base64').toString('utf-8');
  }
}
