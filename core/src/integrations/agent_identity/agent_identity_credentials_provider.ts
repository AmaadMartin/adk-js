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
import {GcpAuthProviderScheme} from './gcp_auth_provider_scheme.js';

/**
 * A backend that turns a {@link GcpAuthProviderScheme} into a credential.
 *
 * `GcpAuthProvider` routes to one of these on the shape of the scheme's
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
      if (response.pending) {
        response = await pollUntil(
          () => this.retrieveCredentials(userId, authScheme),
          isTerminalResponse,
        );
      }
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
      logger.debug('Auth credential obtained.');
      return constructAuthCredential(
        response.success,
        CredentialsServiceName.AGENT_IDENTITY,
      );
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
      baseRetrieveRequest(userId, authScheme),
    );
  }
}
