/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleApiJsonClient, resolveBaseUrl} from './credentials_transport.js';
import {HeaderTokenCredential} from './credentials_utils.js';

const DEFAULT_HOST = 'iamconnectorcredentials.googleapis.com';

/** Environment variable overriding the credentials service host. */
export const TARGET_HOST_ENV_VAR = 'IAM_CONNECTOR_CREDENTIALS_TARGET_HOST';

/** Body of a `connectors.credentials.retrieve` request. */
export interface RetrieveCredentialsRequest {
  userId: string;
  scopes?: string[];
  continueUri?: string;
  forceRefresh?: boolean;
}

/** Credentials issued for the end user. */
export type RetrieveCredentialsResponse = HeaderTokenCredential;

/** Progress reported while a credentials request is still running. */
export interface RetrieveCredentialsMetadata {
  consentPending?: Record<string, never>;
  uriConsentRequired?: {authorizationUri?: string; consentNonce?: string};
}

/** Long-running operation returned by the IAM Connector Credentials service. */
export interface Operation {
  name?: string;
  done?: boolean;
  error?: {code?: number; message?: string};
  response?: RetrieveCredentialsResponse;
  metadata?: RetrieveCredentialsMetadata;
}

/** Transport for the IAM Connector Credentials service. */
export interface IamConnectorCredentialsClient {
  retrieveCredentials(
    connector: string,
    request: RetrieveCredentialsRequest,
  ): Promise<Operation>;
}

/** REST implementation of {@link IamConnectorCredentialsClient}. */
export class RestIamConnectorCredentialsClient implements IamConnectorCredentialsClient {
  private client?: GoogleApiJsonClient;

  async retrieveCredentials(
    connector: string,
    request: RetrieveCredentialsRequest,
  ): Promise<Operation> {
    return this.getClient().post<Operation>(
      `/v1alpha/${connector}/credentials:retrieve`,
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
