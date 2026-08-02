/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../../auth/auth_credential.js';
import {logger} from '../../utils/logger.js';
import {
  buildConsentCredential,
  constructAuthCredential,
  NON_INTERACTIVE_TOKEN_POLL_INTERVAL_MS,
  NON_INTERACTIVE_TOKEN_POLL_TIMEOUT_MS,
  pollWithDeadline,
  requireAgentIdentityContext,
  retrievalFailedMessage,
  wrapRetrievalFailure,
} from './credentials_utils.js';
import {GcpAuthProviderScheme} from './gcp_auth_provider_scheme.js';
import {
  IamConnectorCredentialsClient,
  Operation,
  RestIamConnectorCredentialsClient,
} from './iam_connector_credentials_client.js';

const SERVICE_LABEL = 'IAM Connector Credentials service';
const RESOURCE_KIND = 'connector';
const OPERATION_FAILED_PREFIX = 'Operation failed: ';

/**
 * Credentials provider backed by the IAM Connector Credentials service.
 *
 * Internal: reached through `GcpAuthProvider`, not exported from the package.
 */
export class IamConnectorCredentialsProvider {
  private readonly client: IamConnectorCredentialsClient;

  constructor(client?: IamConnectorCredentialsClient) {
    this.client = client ?? new RestIamConnectorCredentialsClient();
  }

  /**
   * Retrieves credentials for the end user behind `context`.
   *
   * @returns The credential, or an OAuth2 credential carrying only the consent
   *     URI when the user still has to consent, or `undefined` when the
   *     operation reported no known state.
   * @throws If the context identifies no user, the upstream call fails, the
   *     operation carries an error, or consent completed yet is still
   *     demanded.
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

    let operation = await wrapRetrievalFailure(
      () => this.retrieveCredentials(userId, authScheme),
      failureMessage,
    );
    throwIfOperationFailed(operation);
    if (operation.done) {
      logger.debug('Auth credential obtained immediately.');
      return constructAuthCredential(operation.response, SERVICE_LABEL);
    }

    if (operation.metadata?.consentPending) {
      operation = await wrapRetrievalFailure(
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
      throwIfOperationFailed(operation);
      if (operation.done) {
        logger.debug('Auth credential obtained after polling.');
        return constructAuthCredential(operation.response, SERVICE_LABEL);
      }
    }

    const uriConsentRequired = operation.metadata?.uriConsentRequired;
    if (uriConsentRequired) {
      return buildConsentCredential(
        agentIdentityContext,
        uriConsentRequired.authorizationUri,
        uriConsentRequired.consentNonce,
      );
    }
    return undefined;
  }

  private retrieveCredentials(
    userId: string,
    authScheme: GcpAuthProviderScheme,
  ): Promise<Operation> {
    return this.client.retrieveCredentials(authScheme.name, {
      userId,
      scopes: authScheme.scopes,
      continueUri: authScheme.continueUri ?? '',
      forceRefresh: false,
    });
  }
}

function throwIfOperationFailed(operation: Operation): void {
  if (operation.error) {
    throw new Error(
      `${OPERATION_FAILED_PREFIX}${operation.error.message ?? ''}`,
    );
  }
}

function isTerminal(operation: Operation): boolean {
  return Boolean(operation.done);
}
