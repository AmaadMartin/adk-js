/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AuthClient, OAuth2Client} from 'google-auth-library';

import {InputValidationError} from '../errors/input_validation_error.js';

/** Options for {@link BaseGoogleCredentialsConfig}. */
export interface BaseGoogleCredentialsConfigOptions {
  /**
   * An existing auth client to use for every end user, so that no end user
   * goes through the OAuth flow. Application Default Credentials, a service
   * account key, or an authorized user. Mutually exclusive with
   * `externalAccessTokenKey`, `clientId`, `clientSecret` and `scopes`.
   */
  credentials?: AuthClient;
  /**
   * Session-state key holding an access token the hosting application
   * supplies. Mutually exclusive with `credentials`, `clientId`,
   * `clientSecret` and `scopes`.
   */
  externalAccessTokenKey?: string;
  /** The OAuth client id to run the authorization flow with. */
  clientId?: string;
  /** The OAuth client secret to run the authorization flow with. */
  clientSecret?: string;
  /** The OAuth scopes to request. */
  scopes?: string[];
}

/**
 * Base Google credentials configuration for Google API tools.
 *
 * It takes exactly one of three combinations: an existing `credentials`
 * client, an `externalAccessTokenKey`, or a `clientId` and `clientSecret`
 * pair. The constructor rejects anything else. A subclass names the scopes and
 * the token cache key for one Google API.
 */
export class BaseGoogleCredentialsConfig {
  credentials?: AuthClient;
  externalAccessTokenKey?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  /** Session-state key under which a subclass caches its token. */
  tokenCacheKey?: string;

  constructor(options: BaseGoogleCredentialsConfigOptions) {
    validateCredentialsOptions(options);
    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scopes = options.scopes;

    // An authorized-user client already carries the OAuth identity the flow
    // would need, so adopt it.
    if (options.credentials && isOAuth2UserCredential(options.credentials)) {
      this.clientId = options.credentials._clientId;
      this.clientSecret = options.credentials._clientSecret;
      // The auth library stores the granted scope as one space-delimited
      // string. An empty one means no scope was granted.
      const {scope} = options.credentials.credentials;
      this.scopes = scope ? scope.split(' ') : undefined;
    }
  }
}

/** Rejects any combination of options that is not one of the three valid ones. */
function validateCredentialsOptions(
  options: BaseGoogleCredentialsConfigOptions,
): void {
  // adk-python tests these fields for falsiness, so an empty scopes list reads
  // as "not provided" rather than as a conflicting option.
  const hasOAuthOptions = Boolean(
    options.clientId || options.clientSecret || options.scopes?.length,
  );
  if (options.credentials) {
    if (options.externalAccessTokenKey || hasOAuthOptions) {
      throw new InputValidationError(
        'If credentials are provided, externalAccessTokenKey, clientId, ' +
          'clientSecret, and scopes must not be provided.',
      );
    }
    return;
  }
  if (options.externalAccessTokenKey) {
    if (hasOAuthOptions) {
      throw new InputValidationError(
        'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
          'scopes must not be provided.',
      );
    }
    return;
  }
  if (!options.clientId || !options.clientSecret) {
    throw new InputValidationError(
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  }
}

/**
 * Whether the client carries an OAuth identity of its own.
 *
 * adk-python gates this on `isinstance(creds,
 * google.oauth2.credentials.Credentials)`. Node has no single class for that:
 * `JWT`, `Compute` and `UserRefreshClient` all extend `OAuth2Client`, and
 * `_clientId` is a declared field on each, so a property-presence check would
 * match every client. Only a client built with a client id populates it, so
 * the guard tests the values.
 */
function isOAuth2UserCredential(client: AuthClient): client is OAuth2Client {
  return (
    ('_clientId' in client && typeof client._clientId === 'string') ||
    ('_clientSecret' in client && typeof client._clientSecret === 'string')
  );
}
