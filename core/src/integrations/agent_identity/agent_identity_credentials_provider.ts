/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {GcpAuthProviderScheme} from '../agent_registry/types.js';
import {
  AgentIdentityCredentialsClient,
  RestAgentIdentityCredentialsClient,
  RetrieveCredentialsResponse,
} from './agent_identity_credentials_client.js';
import {
  CredentialsResourceNoun,
  CredentialsServiceName,
  baseRetrieveRequest,
  constructAuthCredential,
  isConsentCompleted,
  pollUntil,
  retrievalFailure,
} from './credentials_utils.js';

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
  /** A ready client to use, instead of the REST one built on first use. */
  client?: AgentIdentityCredentialsClient;
}

/** True once the service has told us which of the four states applies. */
function isTerminalResponse(response: RetrieveCredentialsResponse): boolean {
  return Boolean(
    response.success ?? response.uriConsentRequired ?? response.consentRejected,
  );
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
    } catch (error: unknown) {
      throw retrievalFailure(
        userId,
        authScheme.name,
        CredentialsResourceNoun.PROVIDER,
        error,
      );
    }

    if (response.consentRejected) {
      throw new Error('Operation failed: User consent rejected.');
    }

    if (response.success) {
      logger.debug('Auth credential obtained immediately.');
      return constructAuthCredential(
        response.success,
        CredentialsServiceName.AGENT_IDENTITY,
      );
    }

    if (response.pending) {
      try {
        response = await pollUntil(
          () => this.retrieveCredentials(userId, authScheme),
          isTerminalResponse,
        );
      } catch (error: unknown) {
        throw retrievalFailure(
          userId,
          authScheme.name,
          CredentialsResourceNoun.PROVIDER,
          error,
        );
      }
      if (response.consentRejected) {
        throw new Error('Operation failed: User consent rejected.');
      }
      if (response.success) {
        logger.debug('Auth credential obtained after polling.');
        return constructAuthCredential(
          response.success,
          CredentialsServiceName.AGENT_IDENTITY,
        );
      }
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
      `${CredentialsServiceName.AGENT_IDENTITY} service returned an ` +
        'unsupported state.',
    );
  }

  private retrieveCredentials(
    userId: string,
    authScheme: GcpAuthProviderScheme,
  ): Promise<RetrieveCredentialsResponse> {
    this.client ??= new RestAgentIdentityCredentialsClient();
    return this.client.retrieveCredentials(
      authScheme.name,
      baseRetrieveRequest(userId, authScheme),
    );
  }
}
