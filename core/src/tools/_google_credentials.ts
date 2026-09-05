/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AuthClient} from 'google-auth-library';

import {InputValidationError} from '../errors/input_validation_error.js';
import {experimental} from '../utils/experimental.js';

/**
 * Options accepted by every Google credentials config.
 *
 * Exactly one of three authentication modes is valid: a pre-built
 * {@link GoogleCredentialsConfigOptions.credentials} client, an
 * {@link GoogleCredentialsConfigOptions.externalAccessTokenKey}, or a
 * {@link GoogleCredentialsConfigOptions.clientId} and
 * {@link GoogleCredentialsConfigOptions.clientSecret} pair.
 */
export interface GoogleCredentialsConfigOptions {
  /**
   * An auth client the caller already holds: Application Default Credentials,
   * a service account key, or an authorized user. Every end user then shares
   * this one identity, so set it only when it may read every end user's data.
   */
  credentials?: AuthClient;
  /** Key that holds an access token in tool context state. */
  externalAccessTokenKey?: string;
  /** The OAuth client id to run the authorization flow with. */
  clientId?: string;
  /** The OAuth client secret to run the authorization flow with. */
  clientSecret?: string;
  /** The OAuth scopes to request. */
  scopes?: string[];
}

/** The OAuth client details an authorized-user client carries. */
export interface OAuth2UserIdentity {
  _clientId?: string;
  _clientSecret?: string;
}

/**
 * Narrows an auth client to one that carries end-user OAuth2 client details.
 *
 * The check is structural, not `instanceof OAuth2Client`, for two reasons.
 * `instanceof` returns false when two copies of `google-auth-library` share
 * one runtime, and `JWT`, `Compute` and `UserRefreshClient` all extend
 * `OAuth2Client`, so it also matches the service account and metadata clients
 * that carry no OAuth client id. A string client id or secret is the property
 * the harvesting step reads.
 */
export function isOAuth2UserClient(
  client: AuthClient,
): client is AuthClient & OAuth2UserIdentity {
  return (
    ('_clientId' in client && typeof client._clientId === 'string') ||
    ('_clientSecret' in client && typeof client._clientSecret === 'string')
  );
}

/** Rejects options that name no authentication mode, or more than one. */
function validateAuthenticationMode(
  options: GoogleCredentialsConfigOptions,
): void {
  const {credentials, externalAccessTokenKey, clientId, clientSecret, scopes} =
    options;
  if (credentials) {
    if (externalAccessTokenKey || clientId || clientSecret || scopes?.length) {
      throw new InputValidationError(
        'If credentials are provided, externalAccessTokenKey, clientId,' +
          ' clientSecret, and scopes must not be provided.',
      );
    }
  } else if (externalAccessTokenKey) {
    if (clientId || clientSecret || scopes?.length) {
      throw new InputValidationError(
        'If externalAccessTokenKey is provided, clientId, clientSecret, and' +
          ' scopes must not be provided.',
      );
    }
  } else if (!clientId || !clientSecret) {
    throw new InputValidationError(
      'Must provide one of credentials, externalAccessTokenKey, or clientId' +
        ' and clientSecret pair.',
    );
  }
}

/**
 * How a Google API toolset obtains credentials (experimental).
 *
 * A toolset subclasses this to pin its own default scopes and token cache
 * key. The base class validates the authentication mode and adopts the OAuth
 * identity of an authorized-user client, so a caller who already holds one
 * does not repeat its client id, secret and scopes.
 */
@experimental
export class BaseGoogleCredentialsConfig implements GoogleCredentialsConfigOptions {
  credentials?: AuthClient;
  externalAccessTokenKey?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  /**
   * Key under which a resolved token is cached in tool context state. A
   * subclass sets it, and a credential manager reads it.
   */
  tokenCacheKey?: string;

  constructor(options: GoogleCredentialsConfigOptions = {}) {
    validateAuthenticationMode(options);
    Object.assign(this, options);

    if (this.credentials && isOAuth2UserClient(this.credentials)) {
      this.clientId = this.credentials._clientId;
      this.clientSecret = this.credentials._clientSecret;
      // `Credentials.scope` is one space-delimited string, unlike
      // adk-python's list of scopes.
      this.scopes = this.credentials.credentials.scope
        ?.split(' ')
        .filter(Boolean);
    }
  }
}
