/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, GoogleAuth, JWT} from 'google-auth-library';
import {ServiceAccountCredential} from '../../../auth/auth_credential.js';
import {InputValidationError} from '../../../errors/input_validation_error.js';
import {formatError} from '../../../utils/error_utils.js';
import {asJsonObject} from '../../../utils/json_utils.js';

/** OAuth scope every Application Integration and Connectors call is made with. */
export const CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';

/** Deadline for a single API call, matching adk-python's 30 second timeout. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Raised when neither a service account key nor ADC yields a token. */
const NO_CREDENTIALS_MESSAGE =
  'Please provide a service account that has the required permissions to' +
  ' access the connection.';

/** A single JSON request against a Google Cloud API. */
export interface JsonRequest {
  url: string;
  method: 'GET' | 'POST';
  /** Serialised as the JSON request body when present. */
  body?: unknown;
  /** Headers merged on top of the content type and the bearer token. */
  headers?: Record<string, string>;
  /** Error message for an HTTP 400 or 404 response. */
  invalidRequestMessage: string;
}

/**
 * Authenticated JSON transport shared by the Application Integration and the
 * Integration Connectors clients.
 *
 * The credentials have a lifecycle — one client is built and then refreshes its
 * own token — so this is a class rather than a set of free functions. Token
 * caching and refresh are left to `google-auth-library`, which does both.
 */
export class ApiTransport {
  private client?: AuthClient;
  private quotaProject?: string;

  /**
   * @param serviceAccount Key the requests are signed with. Falls back to
   *     Application Default Credentials when omitted.
   */
  constructor(private readonly serviceAccount?: ServiceAccountCredential) {}

  /**
   * Header that bills the request to the caller's own project. Application
   * Default Credentials need it; a service account key does not, because the
   * key already names its project.
   *
   * @throws {Error} If the credentials cannot be resolved.
   */
  async quotaProjectHeaders(
    fallbackProject: string,
  ): Promise<Record<string, string>> {
    if (this.serviceAccount) {
      return {};
    }
    await this.resolveClient();
    return {'x-goog-user-project': this.quotaProject ?? fallbackProject};
  }

  /**
   * Fails before a request goes out when the credentials yield no token.
   * adk-python reports that case with its own message rather than letting the
   * API answer 401.
   *
   * @throws {Error} If the credentials cannot be resolved or yield no token.
   */
  private async assertHasToken(client: AuthClient): Promise<void> {
    let token: string | null | undefined;
    try {
      token = (await client.getAccessToken()).token;
    } catch (error: unknown) {
      throw credentialsError(error);
    }
    if (!token) {
      throw new Error(NO_CREDENTIALS_MESSAGE);
    }
  }

  /**
   * Performs one authenticated JSON request and returns the decoded body.
   *
   * The auth client signs, sends and decodes the call, so no bearer header is
   * built here. `validateStatus` keeps a failing status a value instead of a
   * thrown error, so the mapping below reads the status in one place.
   *
   * @throws {InputValidationError} If the API answers 400 or 404.
   * @throws {Error} If the credentials, the transport or the body fail.
   */
  async fetchJson(request: JsonRequest): Promise<Record<string, unknown>> {
    const client = await this.resolveClient();
    await this.assertHasToken(client);

    let response: {status: number; statusText?: string; data: unknown};
    try {
      response = await client.request<unknown>({
        url: request.url,
        method: request.method,
        data: request.body,
        headers: {'Content-Type': 'application/json', ...request.headers},
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'json',
        validateStatus: () => true,
      });
    } catch (error: unknown) {
      throw new Error(`Request error: ${formatError(error)}`);
    }

    if (response.status < 200 || response.status >= 300) {
      if (response.status === 400 || response.status === 404) {
        throw new InputValidationError(request.invalidRequestMessage);
      }
      throw new Error(
        `Request error: ${response.status} ${response.statusText ?? ''}`.trim(),
      );
    }

    const decoded = asJsonObject(response.data);
    if (!decoded) {
      throw new Error(`Expected a JSON object from ${request.url}.`);
    }
    return decoded;
  }

  private async resolveClient(): Promise<AuthClient> {
    if (this.client) {
      return this.client;
    }
    if (this.serviceAccount) {
      this.client = new JWT({
        email: this.serviceAccount.clientEmail,
        key: this.serviceAccount.privateKey,
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
      return this.client;
    }
    try {
      const auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
      const client = await auth.getClient();
      this.quotaProject =
        client.quotaProjectId ??
        (await auth.getProjectId().catch(() => undefined));
      this.client = client;
      return client;
    } catch (error: unknown) {
      throw credentialsError(error);
    }
  }
}

/** Reports a credentials failure with adk-python's message. */
function credentialsError(error: unknown): Error {
  return new Error(`Credentials error: ${formatError(error)}`);
}
