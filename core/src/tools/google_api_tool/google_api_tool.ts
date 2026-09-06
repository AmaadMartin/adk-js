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

/**
 * The credentials and headers a `GoogleApiTool` configures its wrapped tool
 * with.
 *
 * `clientId` and `clientSecret` are only meaningful together. `serviceAccount`
 * takes precedence over both.
 */
export interface GoogleApiToolOptions {
  /** The OAuth2 client id for the user consent flow. */
  clientId?: string;

  /** The OAuth2 client secret for the user consent flow. */
  clientSecret?: string;

  /** The service account to call the API with, instead of a user. */
  serviceAccount?: ServiceAccount;

  /**
   * Headers merged into every request, such as the developer token Google Ads
   * requires. A header the request already carries always wins.
   */
  additionalHeaders?: Record<string, string>;
}

/**
 * A Google API operation, wrapped with the credentials it runs under.
 *
 * The tool delegates its declaration and its execution to the `RestApiTool`
 * built from a Google API Discovery document, and owns only the credential
 * configuration. It configures the instance it is given rather than a copy, so
 * the wrapped tool carries the credentials afterwards.
 *
 * `GoogleApiToolset` is the intended producer: it builds one of these per
 * operation of a Discovery document.
 *
 * @example
 * ```ts
 * const tools = await new CalendarToolset({
 *   serviceAccount: {useDefaultCredential: true, scopes},
 *   additionalHeaders: {'developer-token': developerToken},
 * }).getTools();
 * ```
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

    if (additionalHeaders && Object.keys(additionalHeaders).length > 0) {
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
  override runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return this.restApiTool.runAsync(request);
  }

  /**
   * Configures the wrapped tool for the OAuth2 user consent flow.
   *
   * @param clientId The OAuth2 client id.
   * @param clientSecret The OAuth2 client secret.
   */
  @experimental
  configureAuth(clientId: string, clientSecret: string) {
    this.restApiTool.configureAuthCredential({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {clientId, clientSecret},
    });
  }

  /**
   * Configures the wrapped tool to call the API as a service account.
   *
   * @param serviceAccount The service account configuration.
   */
  @experimental
  configureSaAuth(serviceAccount: ServiceAccount) {
    const {authScheme, authCredential} =
      serviceAccountSchemeCredential(serviceAccount);
    this.restApiTool.configureAuthScheme(authScheme);
    this.restApiTool.configureAuthCredential(authCredential);
  }
}
