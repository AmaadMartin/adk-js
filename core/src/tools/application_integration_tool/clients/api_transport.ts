/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, GoogleAuth, JWT} from 'google-auth-library';
import {InputValidationError} from '../../../errors/input_validation_error.js';
import {formatError} from '../../../utils/error_utils.js';
import {asJsonObject} from '../../../utils/json_utils.js';
import {parseServiceAccountCredential} from '../../../utils/service_account_utils.js';

/** OAuth scope every Application Integration and Connectors call is made with. */
export const CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';

/** Deadline for a single API call, matching adk-python's 30 second timeout. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Raised when neither a service account key nor ADC yields a token. */
const NO_CREDENTIALS_MESSAGE =
  'Please provide a service account that has the required permissions to' +
  ' access the connection.';

/** HTTP status codes that mean the caller named a resource that cannot exist. */
const INVALID_REQUEST_STATUS = new Set([400, 404]);

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
   * @param serviceAccountJson Raw service account key file contents. Falls
   *     back to Application Default Credentials when omitted.
   */
  constructor(private readonly serviceAccountJson?: string) {}

  /**
   * Resolves the credentials and returns their quota project. Always
   * `undefined` when an explicit service account key is used.
   *
   * @throws {Error} If the credentials cannot be resolved or yield no token.
   */
  async getQuotaProjectId(): Promise<string | undefined> {
    await this.getAccessToken();
    return this.quotaProject;
  }

  /**
   * Returns a bearer token for the configured credentials.
   *
   * @throws {Error} If the credentials cannot be resolved or yield no token.
   */
  async getAccessToken(): Promise<string> {
    let token: string | null | undefined;
    try {
      const client = await this.resolveClient();
      token = (await client.getAccessToken()).token;
    } catch (error: unknown) {
      throw new Error(`Credentials error: ${formatError(error)}`);
    }
    if (!token) {
      throw new Error(NO_CREDENTIALS_MESSAGE);
    }
    return token;
  }

  /**
   * Performs one authenticated JSON request and returns the decoded body.
   *
   * @throws {InputValidationError} If the API answers 400 or 404.
   * @throws {Error} If the credentials, the transport or the body fail.
   */
  async fetchJson(request: JsonRequest): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();

    let response: Awaited<ReturnType<typeof globalThis.fetch>>;
    try {
      response = await globalThis.fetch(request.url, {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...request.headers,
        },
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new Error(`Request error: ${formatError(error)}`);
    }

    if (!response.ok) {
      if (INVALID_REQUEST_STATUS.has(response.status)) {
        throw new InputValidationError(request.invalidRequestMessage);
      }
      throw new Error(
        `Request error: ${response.status} ${response.statusText}`,
      );
    }

    const body = await response.json().catch(() => undefined);
    const decoded = asJsonObject(body);
    if (!decoded) {
      throw new Error(`Expected a JSON object from ${request.url}.`);
    }
    return decoded;
  }

  private async resolveClient(): Promise<AuthClient> {
    if (this.client) {
      return this.client;
    }
    if (this.serviceAccountJson) {
      const key = parseServiceAccountCredential(this.serviceAccountJson);
      this.client = new JWT({
        email: key.clientEmail,
        key: key.privateKey,
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
      return this.client;
    }
    const auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
    const client = await auth.getClient();
    this.quotaProject =
      client.quotaProjectId ??
      (await auth.getProjectId().catch(() => undefined));
    this.client = client;
    return client;
  }
}
