/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../../auth/auth_credential.js';
import {logger} from '../../utils/logger.js';
import {
  AgentIdentityCredentialsClient,
  RestAgentIdentityCredentialsClient,
  RetrieveCredentialsResponse,
} from './agent_identity_credentials_client.js';
import {
  buildConsentCredential,
  CONSENT_REJECTED_ERROR,
  constructAuthCredential,
  NON_INTERACTIVE_TOKEN_POLL_INTERVAL_MS,
  NON_INTERACTIVE_TOKEN_POLL_TIMEOUT_MS,
  pollWithDeadline,
  requireAgentIdentityContext,
  retrievalFailedMessage,
  wrapRetrievalFailure,
} from './credentials_utils.js';
import {GcpAuthProviderScheme} from './gcp_auth_provider_scheme.js';

const SERVICE_LABEL = 'Agent Identity Credentials service';
const RESOURCE_KIND = 'provider';

/**
 * Credentials provider backed by the Agent Identity Credentials service.
 *
 * Internal: reached through `GcpAuthProvider`, not exported from the package.
 */
export class AgentIdentityCredentialsProvider {
  private readonly client: AgentIdentityCredentialsClient;

  constructor(client?: AgentIdentityCredentialsClient) {
    this.client = client ?? new RestAgentIdentityCredentialsClient();
  }

  /**
   * Retrieves credentials for the end user behind `context`.
   *
   * @returns The credential, or an OAuth2 credential carrying only the consent
   *     URI when the user still has to consent, or `undefined` when the
   *     service reported no known state.
   * @throws If the context identifies no user, the upstream call fails, the
   *     user rejected consent, or consent completed yet is still demanded.
   */
  async getAuthCredential(
    authScheme: GcpAuthProviderScheme,
    context?: unknown,
  ): Promise<AuthCredential | undefined> {
    const agentIdentityContext = requireAgentIdentityContext(context);
    const userId = agentIdentityContext.userId;
    const failureMessage = retrievalFailedMessage(
      userId,
      RESOURCE_KIND,
      authScheme.name,
    );

    let response = await wrapRetrievalFailure(
      () => this.retrieveCredentials(userId, authScheme),
      failureMessage,
    );

    if (response.consentRejected) {
      throw new Error(CONSENT_REJECTED_ERROR);
    }
    if (response.success) {
      logger.debug('Auth credential obtained immediately.');
      return constructAuthCredential(response.success, SERVICE_LABEL);
    }

    if (response.pending) {
      response = await wrapRetrievalFailure(
        () =>
          pollWithDeadline(
            () => this.retrieveCredentials(userId, authScheme),
            isTerminal,
            {
              timeoutMs: NON_INTERACTIVE_TOKEN_POLL_TIMEOUT_MS,
              intervalMs: NON_INTERACTIVE_TOKEN_POLL_INTERVAL_MS,
            },
          ),
        failureMessage,
      );
      if (response.consentRejected) {
        throw new Error(CONSENT_REJECTED_ERROR);
      }
      if (response.success) {
        logger.debug('Auth credential obtained after polling.');
        return constructAuthCredential(response.success, SERVICE_LABEL);
      }
    }

    if (response.uriConsentRequired) {
      return buildConsentCredential(
        agentIdentityContext,
        response.uriConsentRequired.authorizationUri,
        response.uriConsentRequired.consentNonce,
      );
    }
    return undefined;
  }

  private retrieveCredentials(
    userId: string,
    authScheme: GcpAuthProviderScheme,
  ): Promise<RetrieveCredentialsResponse> {
    return this.client.retrieveCredentials(authScheme.name, {
      userId,
      scopes: authScheme.scopes,
      continueUri: authScheme.continueUri ?? '',
    });
  }
}

function isTerminal(response: RetrieveCredentialsResponse): boolean {
  return Boolean(
    response.success || response.uriConsentRequired || response.consentRejected,
  );
}
