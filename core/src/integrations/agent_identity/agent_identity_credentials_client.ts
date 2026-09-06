/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {
  BaseRetrieveRequest,
  CredentialsServiceName,
  HeaderCredentials,
  postRetrieveCredentials,
} from './credentials_utils.js';

/** Default host of the Agent Identity Credentials v1 API. */
const DEFAULT_TARGET_HOST = 'agentidentitycredentials.googleapis.com';

/** Environment variable that overrides {@link DEFAULT_TARGET_HOST}. */
const TARGET_HOST_ENV_VAR = 'AGENT_IDENTITY_CREDENTIALS_TARGET_HOST';

/** The OAuth scope the Agent Identity Credentials API declares. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Request body of `POST v1/{authProvider}/credentials:retrieve`.
 *
 * Field names follow the v1 discovery document, so they are camelCase on the
 * wire. The service also reads `forceRefreshToken`, which this client never
 * sends, so the body is the base request and nothing more.
 */
export type RetrieveCredentialsRequest = BaseRetrieveRequest;

/** The credentials the service returned. */
export type RetrieveCredentialsSuccess = HeaderCredentials;

/** The consent the end user must give before a token exists. */
export interface UriConsentRequired {
  /** Where to send the user to grant consent. */
  authorizationUri?: string;

  /** A one-time value that ties the whole consent flow to one user. */
  consentNonce?: string;
}

/**
 * The response of `credentials:retrieve`. The service sets exactly one of the
 * four fields.
 */
export interface RetrieveCredentialsResponse {
  /** Credentials are available now. */
  success?: RetrieveCredentialsSuccess;

  /** Credentials are not ready; the caller should poll. */
  pending?: Record<string, never>;

  /** The end user must grant consent first. */
  uriConsentRequired?: UriConsentRequired;

  /** The end user refused consent. */
  consentRejected?: Record<string, never>;
}

/** Reads credentials from the Agent Identity Credentials service. */
export interface AgentIdentityCredentialsClient {
  /**
   * Retrieves credentials for one end user from one auth provider.
   *
   * @param authProvider The auth provider resource name.
   * @param request The retrieval request.
   * @returns The service response, in exactly one of its four states.
   */
  retrieveCredentials(
    authProvider: string,
    request: RetrieveCredentialsRequest,
  ): Promise<RetrieveCredentialsResponse>;
}

/**
 * The default client. It calls the Agent Identity Credentials v1 REST API with
 * Application Default Credentials.
 *
 * It does not retry: `google-auth-library` refreshes its own token, and the
 * platform retries the transport.
 */
export class RestAgentIdentityCredentialsClient implements AgentIdentityCredentialsClient {
  private readonly host: string;
  private readonly auth: GoogleAuth;

  constructor() {
    this.host = process.env[TARGET_HOST_ENV_VAR] || DEFAULT_TARGET_HOST;
    this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  }

  retrieveCredentials(
    authProvider: string,
    request: RetrieveCredentialsRequest,
  ): Promise<RetrieveCredentialsResponse> {
    return postRetrieveCredentials(
      this.auth,
      {
        host: this.host,
        apiVersion: 'v1',
        resource: authProvider,
        service: CredentialsServiceName.AGENT_IDENTITY,
      },
      request,
    );
  }
}
