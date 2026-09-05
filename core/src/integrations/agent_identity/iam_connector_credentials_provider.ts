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
import {CredentialsProvider} from './agent_identity_credentials_provider.js';
import {
  CredentialsResourceNoun,
  CredentialsServiceName,
  baseRetrieveRequest,
  constructAuthCredential,
  isConsentCompleted,
  pollUntil,
  retrievalFailure,
} from './credentials_utils.js';
import {
  IamConnectorCredentialsClient,
  RestIamConnectorCredentialsClient,
  RetrieveConnectorCredentialsRequest,
  RetrieveCredentialsOperation,
  RetrieveCredentialsResult,
} from './iam_connector_credentials_client.js';

/** Options for {@link IamConnectorCredentialsProvider}. */
export interface IamConnectorCredentialsProviderOptions {
  /** A ready client to use, instead of the REST one built on first use. */
  client?: IamConnectorCredentialsClient;
}

/** The credentials of a completed operation, which must carry some. */
function requireCredentials(
  response: RetrieveCredentialsResult | undefined,
): RetrieveCredentialsResult {
  if (!response) {
    throw new Error(
      `${CredentialsServiceName.IAM_CONNECTOR} operation completed without a ` +
        'response.',
    );
  }
  return response;
}

/** The error a failed operation carries. */
function operationFailure(operation: RetrieveCredentialsOperation): Error {
  return new Error(`Operation failed: ${operation.error?.message}`);
}

/**
 * Fetches end-user credentials from the Google Cloud IAM Connector Credentials
 * service.
 *
 * The service serves the legacy `projects/*\/locations/*\/connectors/*`
 * resource names. It answers with a long-running operation rather than a
 * credential, so a pending retrieval reports its state in the operation
 * metadata.
 */
@experimental
export class IamConnectorCredentialsProvider implements CredentialsProvider {
  private client?: IamConnectorCredentialsClient;

  constructor(options?: IamConnectorCredentialsProviderOptions) {
    this.client = options?.client;
  }

  /**
   * Retrieves a credential for the context's user.
   *
   * @param authScheme The scheme naming the connector resource.
   * @param context The context of the current tool call.
   * @returns A bearer credential, a custom-header credential, or an OAuth2
   *     credential carrying the consent URI the user must visit.
   * @throws Error If the context has no user, the service fails, the operation
   *     failed, polling timed out, or the service returned a state this
   *     provider does not serve.
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

    let operation: RetrieveCredentialsOperation;
    try {
      operation = await this.retrieveCredentials(userId, authScheme);
    } catch (error: unknown) {
      throw retrievalFailure(
        userId,
        authScheme.name,
        CredentialsResourceNoun.CONNECTOR,
        error,
      );
    }

    if (operation.error) {
      throw operationFailure(operation);
    }

    if (operation.done) {
      logger.debug('Auth credential obtained immediately.');
      return constructAuthCredential(
        requireCredentials(operation.response),
        CredentialsServiceName.IAM_CONNECTOR,
      );
    }

    if (operation.metadata?.consentPending) {
      let completed: RetrieveCredentialsOperation;
      try {
        completed = await pollUntil(
          () => this.retrieveCredentials(userId, authScheme),
          (operation) => Boolean(operation.done),
        );
      } catch (error: unknown) {
        throw retrievalFailure(
          userId,
          authScheme.name,
          CredentialsResourceNoun.CONNECTOR,
          error,
        );
      }
      if (completed.error) {
        throw operationFailure(completed);
      }
      logger.debug('Auth credential obtained after polling.');
      return constructAuthCredential(
        requireCredentials(completed.response),
        CredentialsServiceName.IAM_CONNECTOR,
      );
    }

    if (operation.metadata?.uriConsentRequired) {
      if (isConsentCompleted(context)) {
        throw new Error('Failed to retrieve consent based credential.');
      }
      return {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          authUri: operation.metadata.uriConsentRequired.authorizationUri,
          nonce: operation.metadata.uriConsentRequired.consentNonce,
        },
      };
    }

    throw new Error(
      `${CredentialsServiceName.IAM_CONNECTOR} service returned an ` +
        'unsupported state.',
    );
  }

  private retrieveCredentials(
    userId: string,
    authScheme: GcpAuthProviderScheme,
  ): Promise<RetrieveCredentialsOperation> {
    this.client ??= new RestIamConnectorCredentialsClient();
    const request: RetrieveConnectorCredentialsRequest = {
      ...baseRetrieveRequest(userId, authScheme),
      forceRefresh: false,
    };
    return this.client.retrieveCredentials(authScheme.name, request);
  }
}
