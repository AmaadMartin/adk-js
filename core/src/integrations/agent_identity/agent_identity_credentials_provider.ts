/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../../agents/framework_function_calls.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {getFunctionCalls, getFunctionResponses} from '../../events/event.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {GcpAuthProviderScheme} from '../agent_registry/types.js';
import {
  AgentIdentityCredentialsClient,
  RestAgentIdentityCredentialsClient,
  RetrieveCredentialsRequest,
  RetrieveCredentialsResponse,
  RetrieveCredentialsSuccess,
} from './agent_identity_credentials_client.js';

/** How long to wait between polls while the service reports `pending`. */
const NON_INTERACTIVE_TOKEN_POLL_INTERVAL_MS = 1000;

/** How long to keep polling before giving up. */
const NON_INTERACTIVE_TOKEN_POLL_TIMEOUT_MS = 10000;

/** The argument that carries the tool call a credential request belongs to. */
const FUNCTION_CALL_ID_ARG = 'functionCallId';

/**
 * A backend that turns a {@link GcpAuthProviderScheme} into a credential.
 *
 * {@link GcpAuthProvider} routes to one of these on the shape of the scheme's
 * resource name.
 */
export interface CredentialsProvider {
  getAuthCredential(
    authScheme: GcpAuthProviderScheme,
    context?: Context,
  ): Promise<AuthCredential>;
}

/** Options for {@link AgentIdentityCredentialsProvider}. */
export interface AgentIdentityCredentialsProviderOptions {
  /** A ready client to use, instead of the default REST client. */
  client?: AgentIdentityCredentialsClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True once the service has told us which of the four states applies. */
function isTerminalResponse(response: RetrieveCredentialsResponse): boolean {
  return Boolean(
    response.success ?? response.uriConsentRequired ?? response.consentRejected,
  );
}

function buildRetrieveRequest(
  userId: string,
  authScheme: GcpAuthProviderScheme,
): RetrieveCredentialsRequest {
  const request: RetrieveCredentialsRequest = {userId};
  if (authScheme.scopes) {
    request.scopes = authScheme.scopes;
  }
  if (authScheme.continueUri) {
    request.continueUri = authScheme.continueUri;
  }
  return request;
}

function retrievalFailure(
  userId: string,
  providerName: string,
  cause: unknown,
): Error {
  return new Error(
    `Failed to retrieve credential for user '${userId}' on provider ` +
      `'${providerName}'.`,
    {cause},
  );
}

/**
 * Builds an HTTP credential from the header/token pair the service returned.
 *
 * A header of `Authorization: Bearer` becomes a bearer credential. Any other
 * header name is sent verbatim, alongside `X-GOOG-API-KEY`.
 */
export function constructAuthCredential(
  success: RetrieveCredentialsSuccess,
): AuthCredential {
  const {header, token} = success;
  if (!header || !token) {
    throw new Error(
      'Received either empty header or token from Agent Identity Credentials' +
        ' service.',
    );
  }

  const separator = header.indexOf(':');
  const headerName = separator === -1 ? header : header.slice(0, separator);
  const headerValue = separator === -1 ? '' : header.slice(separator + 1);
  if (
    headerName.trim().toLowerCase() === 'authorization' &&
    headerValue.trim().toLowerCase().startsWith('bearer')
  ) {
    return {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token}},
    };
  }

  return {
    authType: AuthCredentialTypes.HTTP,
    http: {
      // A custom header carries the token itself, so scheme and credentials
      // stay empty.
      scheme: '',
      credentials: {},
      additionalHeaders: {[header]: token, 'X-GOOG-API-KEY': token},
    },
  };
}

/**
 * True when the end user already answered the credential request that belongs
 * to this tool call.
 *
 * The provider uses it to tell a first consent prompt from a repeat one: a
 * second `uriConsentRequired` after the user answered means the consent did not
 * produce a credential.
 */
export function isConsentCompleted(context: Context): boolean {
  if (!context.functionCallId) {
    return false;
  }
  const requestedFunctionCallIds = new Map<string, unknown>();
  const answeredCallIds = new Set<string>();
  for (const event of context.invocationContext.session.events) {
    for (const call of getFunctionCalls(event)) {
      if (call.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME && call.id) {
        requestedFunctionCallIds.set(
          call.id,
          call.args?.[FUNCTION_CALL_ID_ARG],
        );
      }
    }
    for (const response of getFunctionResponses(event)) {
      if (
        response.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME &&
        response.id
      ) {
        answeredCallIds.add(response.id);
      }
    }
  }

  for (const callId of answeredCallIds) {
    if (requestedFunctionCallIds.get(callId) === context.functionCallId) {
      return true;
    }
  }
  return false;
}

/**
 * Fetches end-user credentials from the Google Cloud Agent Identity
 * Credentials service.
 */
@experimental
export class AgentIdentityCredentialsProvider implements CredentialsProvider {
  private client?: AgentIdentityCredentialsClient;

  constructor(options?: AgentIdentityCredentialsProviderOptions) {
    this.client = options?.client;
  }

  /**
   * Retrieves a credential for the context's user.
   *
   * @param authScheme The scheme naming the auth provider resource.
   * @param context The context of the current tool call.
   * @returns A bearer credential, a custom-header credential, or an OAuth2
   *     credential carrying the consent URI the user must visit.
   * @throws Error If the context has no user, the service fails, the user
   *     rejected consent, polling timed out, or the service returned a state
   *     this provider does not serve.
   */
  async getAuthCredential(
    authScheme: GcpAuthProviderScheme,
    context?: Context,
  ): Promise<AuthCredential> {
    if (!context?.userId) {
      throw new Error(
        'GcpAuthProvider requires a context with a valid user_id.',
      );
    }
    const userId = context.userId;

    let response: RetrieveCredentialsResponse;
    try {
      response = await this.retrieveCredentials(userId, authScheme);
      if (response.pending) {
        response = await this.pollCredentials(userId, authScheme);
      }
    } catch (error: unknown) {
      throw retrievalFailure(userId, authScheme.name, error);
    }

    if (response.consentRejected) {
      throw new Error('Operation failed: User consent rejected.');
    }

    if (response.success) {
      logger.debug('Auth credential obtained.');
      return constructAuthCredential(response.success);
    }

    if (response.uriConsentRequired) {
      if (isConsentCompleted(context)) {
        throw new Error('Failed to retrieve consent based credential.');
      }
      return {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          authUri: response.uriConsentRequired.authorizationUri,
          nonce: response.uriConsentRequired.consentNonce,
        },
      };
    }

    throw new Error(
      'Agent Identity Credentials service returned an unsupported state.',
    );
  }

  private getClient(): AgentIdentityCredentialsClient {
    // Built lazily, so constructing the provider does not resolve credentials.
    this.client ??= new RestAgentIdentityCredentialsClient();
    return this.client;
  }

  private retrieveCredentials(
    userId: string,
    authScheme: GcpAuthProviderScheme,
  ): Promise<RetrieveCredentialsResponse> {
    return this.getClient().retrieveCredentials(
      authScheme.name,
      buildRetrieveRequest(userId, authScheme),
    );
  }

  private async pollCredentials(
    userId: string,
    authScheme: GcpAuthProviderScheme,
  ): Promise<RetrieveCredentialsResponse> {
    const endTime = Date.now() + NON_INTERACTIVE_TOKEN_POLL_TIMEOUT_MS;
    while (Date.now() < endTime) {
      const response = await this.retrieveCredentials(userId, authScheme);
      if (isTerminalResponse(response)) {
        return response;
      }
      await sleep(NON_INTERACTIVE_TOKEN_POLL_INTERVAL_MS);
    }
    throw new Error('Timeout waiting for credentials.');
  }
}
