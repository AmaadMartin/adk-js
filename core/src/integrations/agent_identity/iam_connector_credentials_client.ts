/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {HeaderCredentials} from './credentials_utils.js';

/** Default host of the IAM Connector Credentials v1alpha API. */
const DEFAULT_TARGET_HOST = 'iamconnectorcredentials.googleapis.com';

/** Environment variable that overrides {@link DEFAULT_TARGET_HOST}. */
const TARGET_HOST_ENV_VAR = 'IAM_CONNECTOR_CREDENTIALS_TARGET_HOST';

/** The OAuth scope the IAM Connector Credentials API declares. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Request body of `POST v1alpha/{connector}/credentials:retrieve`. */
export interface RetrieveConnectorCredentialsRequest {
  /** The identity of the end user. */
  userId: string;

  /** The OAuth scopes the caller needs. */
  scopes?: string[];

  /** Where the connector sends the user once consent completes. */
  continueUri?: string;

  /**
   * Makes the service mint a new token instead of returning a cached one. The
   * provider always sends `false`, matching adk-python.
   */
  forceRefresh: boolean;
}

/** The credentials a completed operation carries. */
export type RetrieveCredentialsResult = HeaderCredentials & {
  /** When the token expires, if the service knows. */
  expireTime?: string;

  /** The scopes the token actually carries, which may be fewer than asked. */
  scopes?: string[];
};

/** The consent the end user must give before a token exists. */
export interface ConnectorUriConsentRequired {
  /** Where to send the user to grant consent. */
  authorizationUri?: string;

  /** A one-time value that ties the whole consent flow to one user. */
  consentNonce?: string;
}

/**
 * Progress of a retrieval that has not completed. The service sets at most one
 * of the three status fields.
 */
export interface RetrieveCredentialsMetadata {
  /** The token is being minted; the caller should poll. */
  consentPending?: Record<string, never>;

  /** The end user must grant consent first. */
  uriConsentRequired?: ConnectorUriConsentRequired;

  /**
   * The end user refused consent. adk-python's provider does not read it, so
   * this port does not either: it reports an unsupported state instead.
   */
  consentRejected?: Record<string, never>;

  /** When the service started the retrieval. */
  createTime?: string;
}

/** A `google.longrunning.Operation` as the service renders it over REST. */
export interface RetrieveCredentialsOperation {
  /** The operation resource name. */
  name?: string;

  /** True once the operation finished, successfully or not. */
  done?: boolean;

  /** Why the operation failed, when it did. */
  error?: {code?: number; message?: string};

  /** The credentials, set when `done` is true and the operation succeeded. */
  response?: RetrieveCredentialsResult;

  /** Why the operation is still running. */
  metadata?: RetrieveCredentialsMetadata;
}

/** Reads credentials from the IAM Connector Credentials service. */
export interface IamConnectorCredentialsClient {
  /**
   * Retrieves credentials for one end user from one IAM connector.
   *
   * @param connector The connector resource name.
   * @param request The retrieval request.
   * @returns The long-running operation the service returned.
   */
  retrieveCredentials(
    connector: string,
    request: RetrieveConnectorCredentialsRequest,
  ): Promise<RetrieveCredentialsOperation>;
}

/**
 * The default client. It calls the IAM Connector Credentials v1alpha REST API
 * with Application Default Credentials.
 *
 * It does not retry: `google-auth-library` refreshes its own token, and the
 * platform retries the transport.
 */
export class RestIamConnectorCredentialsClient implements IamConnectorCredentialsClient {
  private readonly host: string;
  private readonly auth: GoogleAuth;

  constructor() {
    this.host = process.env[TARGET_HOST_ENV_VAR] || DEFAULT_TARGET_HOST;
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  }

  async retrieveCredentials(
    connector: string,
    request: RetrieveConnectorCredentialsRequest,
  ): Promise<RetrieveCredentialsOperation> {
    const url = `https://${this.host}/v1alpha/${connector}/credentials:retrieve`;
    const client = await this.auth.getClient();
    const headers = await client.getRequestHeaders(url);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(
        `IAM Connector Credentials request failed with status ` +
          `${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()) as RetrieveCredentialsOperation;
  }
}
