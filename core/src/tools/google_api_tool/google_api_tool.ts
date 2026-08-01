/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {
  AuthCredentialTypes,
  ServiceAccount,
} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {serviceAccountSchemeCredential} from '../openapi_tool/auth/auth_helpers.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';

/** Credential and header configuration shared by every Google API tool. */
export interface GoogleApiToolOptions {
  /** OAuth2 client id for the user consent flow. */
  clientId?: string;
  /** OAuth2 client secret for the user consent flow. */
  clientSecret?: string;
  /** Service account used instead of the OAuth2 consent flow. */
  serviceAccount?: ServiceAccount;
  /** Headers added to every request, never overwriting an existing one. */
  additionalHeaders?: Record<string, string>;
}

/**
 * A single operation of a Google API, backed by a {@link RestApiTool} built
 * from the API's Discovery document.
 *
 * The tool carries the credentials the operation is invoked with: either an
 * OAuth2 client id/secret pair for the user consent flow, or a service
 * account.
 */
@experimental
export class GoogleApiTool extends BaseTool {
  constructor(
    private readonly restApiTool: RestApiTool,
    options: GoogleApiToolOptions = {},
  ) {
    super({
      name: restApiTool.name,
      description: restApiTool.description,
      isLongRunning: restApiTool.isLongRunning,
    });

    const {clientId, clientSecret, serviceAccount, additionalHeaders} = options;
    if (additionalHeaders) {
      this.restApiTool.setDefaultHeaders(additionalHeaders);
    }
    if (serviceAccount) {
      this.configureSaAuth(serviceAccount);
    } else if (clientId && clientSecret) {
      this.configureAuth(clientId, clientSecret);
    }
  }

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    return this.restApiTool._getDeclaration();
  }

  @experimental
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return this.restApiTool.runAsync(request);
  }

  /** Authenticates through the OAuth2 user consent flow. */
  @experimental
  configureAuth(clientId: string, clientSecret: string): void {
    this.restApiTool.configureAuthCredential({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {clientId, clientSecret},
    });
  }

  /** Authenticates as the given service account. */
  @experimental
  configureSaAuth(serviceAccount: ServiceAccount): void {
    const {authScheme, authCredential} =
      serviceAccountSchemeCredential(serviceAccount);
    this.restApiTool.configureAuthScheme(authScheme);
    this.restApiTool.configureAuthCredential(authCredential);
  }
}
