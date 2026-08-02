/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleApiJsonClient, resolveBaseUrl} from './credentials_transport.js';
import {HeaderTokenCredential} from './credentials_utils.js';

const DEFAULT_HOST = 'agentidentitycredentials.googleapis.com';

/** Environment variable overriding the credentials service host. */
export const TARGET_HOST_ENV_VAR = 'AGENT_IDENTITY_CREDENTIALS_TARGET_HOST';

/** Body of an `authProviders.credentials.retrieve` request. */
export interface RetrieveCredentialsRequest {
  userId: string;
  scopes?: string[];
  continueUri?: string;
}

/** Credentials issued for the end user. */
export interface Success extends HeaderTokenCredential {
  expireTime?: string;
  scopes?: string[];
}

/** Instructions for driving the end user through a consent flow. */
export interface UriConsentRequired {
  authorizationUri?: string;
  consentNonce?: string;
  uid?: string;
}

/**
 * Response of an `authProviders.credentials.retrieve` request.
 *
 * Exactly one field is populated, identifying the state of the request.
 */
export interface RetrieveCredentialsResponse {
  success?: Success;
  pending?: Record<string, never>;
  uriConsentRequired?: UriConsentRequired;
  consentRejected?: Record<string, never>;
}

/** Transport for the Agent Identity Credentials service. */
export interface AgentIdentityCredentialsClient {
  retrieveCredentials(
    authProvider: string,
    request: RetrieveCredentialsRequest,
  ): Promise<RetrieveCredentialsResponse>;
}

/** REST implementation of {@link AgentIdentityCredentialsClient}. */
export class RestAgentIdentityCredentialsClient implements AgentIdentityCredentialsClient {
  private client?: GoogleApiJsonClient;

  async retrieveCredentials(
    authProvider: string,
    request: RetrieveCredentialsRequest,
  ): Promise<RetrieveCredentialsResponse> {
    return this.getClient().post<RetrieveCredentialsResponse>(
      `/v1/${authProvider}/credentials:retrieve`,
      request,
    );
  }

  /** Lazily builds the client to avoid unnecessary setup on startup. */
  private getClient(): GoogleApiJsonClient {
    this.client ??= new GoogleApiJsonClient(
      resolveBaseUrl(TARGET_HOST_ENV_VAR, DEFAULT_HOST),
    );
    return this.client;
  }
}
