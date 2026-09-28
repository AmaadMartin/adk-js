/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {parseServiceAccountJson} from '../../../utils/service_account_utils.js';
import {CLOUD_PLATFORM_SCOPE} from '../constants.js';
import {
  ApplicationIntegrationError,
  ApplicationIntegrationErrorCode,
} from '../errors.js';

/** Statuses the APIs use to report a malformed or unknown resource. */
const INVALID_REQUEST_STATUSES = new Set([400, 404]);

export interface ApiTransportOptions {
  project: string;
  location: string;
  /** A service account key file. Application Default Credentials if omitted. */
  serviceAccountJson?: string;
  /**
   * Names the resource in an "invalid request" message, so the message points
   * at the value the caller got wrong, e.g. `connection(my-connection)`.
   */
  resourceDescription: string;
}

/**
 * Authenticated JSON transport for the Application Integration and Integration
 * Connectors APIs.
 *
 * The transport owns the auth client, which caches and refreshes the access
 * token, so callers do not track token expiry themselves.
 */
export class ApiTransport {
  private readonly project: string;
  private readonly location: string;
  private readonly serviceAccountJson?: string;
  private readonly resourceDescription: string;

  /** The auth client, created on first use and reused afterwards. */
  private auth?: GoogleAuth;

  constructor(options: ApiTransportOptions) {
    this.project = options.project;
    this.location = options.location;
    this.serviceAccountJson = options.serviceAccountJson;
    this.resourceDescription = options.resourceDescription;
  }

  /**
   * Returns an access token for the cloud-platform scope.
   *
   * @throws {ApplicationIntegrationError} With code `CREDENTIALS` when no
   *     credential resolves.
   */
  async getAccessToken(): Promise<string> {
    let token: string | null | undefined;
    try {
      token = await this.getAuth().getAccessToken();
    } catch (error) {
      throw credentialsError(error);
    }

    if (!token) {
      throw new ApplicationIntegrationError(
        ApplicationIntegrationErrorCode.CREDENTIALS,
        'Please provide a service account that has the required permissions' +
          ' to access the connection.',
      );
    }
    return token;
  }

  /**
   * The project to bill and enforce quota against, for callers that send
   * `x-goog-user-project`.
   */
  async getQuotaProjectId(): Promise<string | undefined> {
    const auth = this.getAuth();
    return (await auth.getClient()).quotaProjectId ?? auth.getProjectId();
  }

  /** Sends an authenticated GET and returns the parsed JSON body. */
  async get(url: string): Promise<unknown> {
    return this.send(url, {method: 'GET'});
  }

  /** Sends an authenticated POST and returns the parsed JSON body. */
  async post(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    return this.send(url, {
      method: 'POST',
      body: JSON.stringify(body),
      extraHeaders,
    });
  }

  /**
   * `GoogleAuth` mints from an explicit key file and from Application Default
   * Credentials alike, so one client covers both.
   */
  private getAuth(): GoogleAuth {
    if (!this.auth) {
      this.auth = new GoogleAuth({
        credentials: this.serviceAccountJson
          ? readKeyFile(this.serviceAccountJson)
          : undefined,
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
    }
    return this.auth;
  }

  private async send(
    url: string,
    request: {
      method: 'GET' | 'POST';
      body?: string;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${await this.getAccessToken()}`,
      ...request.extraHeaders,
    };

    const response = await fetchOrThrow(url, {
      method: request.method,
      headers,
      body: request.body,
    });

    if (!response.ok) {
      throw this.responseError(response.status, response.statusText);
    }
    return response.json();
  }

  private responseError(
    status: number,
    statusText: string,
  ): ApplicationIntegrationError {
    if (INVALID_REQUEST_STATUSES.has(status)) {
      return new ApplicationIntegrationError(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
        `Invalid request. Please check the provided values of` +
          ` project(${this.project}), location(${this.location}),` +
          ` ${this.resourceDescription}.`,
      );
    }
    return new ApplicationIntegrationError(
      ApplicationIntegrationErrorCode.REQUEST_FAILED,
      `Request error: ${status} ${statusText}`,
    );
  }
}

/**
 * Reads a key file into the snake_case shape `GoogleAuth` expects.
 *
 * @throws {ApplicationIntegrationError} With code `CREDENTIALS` when the file
 *     is unreadable.
 */
function readKeyFile(serviceAccountJson: string) {
  try {
    const credential = parseServiceAccountJson(serviceAccountJson);
    return {
      client_email: credential.clientEmail,
      private_key: credential.privateKey,
    };
  } catch (error) {
    throw credentialsError(error);
  }
}

async function fetchOrThrow(url: string, init: Parameters<typeof fetch>[1]) {
  try {
    return await globalThis.fetch(url, init);
  } catch (error) {
    throw new ApplicationIntegrationError(
      ApplicationIntegrationErrorCode.REQUEST_FAILED,
      `Request error: ${(error as Error).message}`,
      {cause: error},
    );
  }
}

function credentialsError(cause: unknown): ApplicationIntegrationError {
  return new ApplicationIntegrationError(
    ApplicationIntegrationErrorCode.CREDENTIALS,
    `Credentials error: ${(cause as Error).message}`,
    {cause},
  );
}
