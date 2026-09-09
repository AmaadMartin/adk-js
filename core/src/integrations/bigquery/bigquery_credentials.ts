/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AuthClient, OAuth2Client} from 'google-auth-library';

import {InputValidationError} from '../../errors/input_validation_error.js';
import {experimental} from '../../utils/experimental.js';

/**
 * The scopes the BigQuery tools request when the caller names none. The tools
 * read table data through the BigQuery API and table metadata through Dataplex,
 * so a credential scoped to BigQuery alone fails the metadata calls.
 */
export const BIGQUERY_SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/dataplex.read-write',
];

/**
 * Options for {@link BigQueryCredentialsConfig}.
 *
 * Every field is optional here because the rule the constructor enforces is
 * mutual exclusion between three groups, which TypeScript cannot express.
 */
export interface BigQueryCredentialsConfigOptions {
  /**
   * A ready auth client, used for every end user, so that no end user goes
   * through the OAuth flow. Application Default Credentials, a service account
   * key, or an authorized user. Mutually exclusive with every other field.
   */
  credentials?: AuthClient;
  /**
   * Session-state key holding a bare access token that the host application
   * already obtained. Mutually exclusive with `credentials`, `clientId`,
   * `clientSecret` and `scopes`.
   */
  externalAccessTokenKey?: string;
  /** The OAuth client id to run the end-user authorization flow with. */
  clientId?: string;
  /** The OAuth client secret to run the end-user authorization flow with. */
  clientSecret?: string;
  /** The OAuth scopes to request. Defaults to {@link BIGQUERY_SCOPES}. */
  scopes?: string[];
}

/**
 * Credential configuration for the BigQuery tools (experimental).
 *
 * Exactly one of three combinations is valid: a ready `credentials` client, an
 * `externalAccessTokenKey`, or a `clientId` and `clientSecret` pair. The
 * constructor rejects anything else, so a constructed instance always names
 * one credential source.
 *
 * {@link BIGQUERY_SCOPES} applies when the configuration resolves to no scope.
 * An empty `scopes` list therefore falls back to it, and an authorized-user
 * client that carries its own granted scopes keeps them.
 *
 * ```ts
 * // Application Default Credentials, with the BigQuery scopes.
 * const config = new BigQueryCredentialsConfig({credentials: authClient});
 *
 * // Or let each end user authorize the agent through the OAuth flow.
 * const config = new BigQueryCredentialsConfig({
 *   clientId: process.env.OAUTH_CLIENT_ID,
 *   clientSecret: process.env.OAUTH_CLIENT_SECRET,
 * });
 * ```
 */
@experimental
export class BigQueryCredentialsConfig {
  readonly credentials?: AuthClient;
  readonly externalAccessTokenKey?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes: string[];

  constructor(options: BigQueryCredentialsConfigOptions) {
    validateCredentialSource(options);
    // An authorized-user client already carries the OAuth identity and the
    // granted scopes, so adopt them. adk-python copies the same three fields
    // off a `google.oauth2.credentials.Credentials`.
    const oauth =
      options.credentials && isOAuth2Client(options.credentials)
        ? options.credentials
        : undefined;
    this.credentials = options.credentials;
    this.externalAccessTokenKey = options.externalAccessTokenKey;
    this.clientId = oauth?._clientId ?? options.clientId;
    this.clientSecret = oauth?._clientSecret ?? options.clientSecret;
    const granted = oauth?.credentials.scope?.split(' ').filter(Boolean);
    // Copied rather than referenced, so that a later mutation of either the
    // caller's array or BIGQUERY_SCOPES cannot reach a validated config.
    const scopes = granted ?? options.scopes;
    this.scopes = scopes?.length ? [...scopes] : [...BIGQUERY_SCOPES];
  }
}

/**
 * Whether the client belongs to the OAuth2 family, and so may carry an OAuth
 * identity. Structural rather than `instanceof`, which is false across two
 * copies of google-auth-library in one runtime.
 *
 * Exported for the tests only. `core/src/index.ts` names the public symbols of
 * this module explicitly, so this generic guard stays out of `@google/adk`.
 */
export function isOAuth2Client(
  credentials: AuthClient,
): credentials is OAuth2Client {
  return 'generateAuthUrl' in credentials;
}

/**
 * Rejects any combination of options that is not one of the three valid ones.
 *
 * The messages name fields only, never values, because `clientSecret` must not
 * reach a log line.
 */
function validateCredentialSource(
  options: BigQueryCredentialsConfigOptions,
): void {
  // An empty scope list names no scope, so it is not an OAuth option. This
  // matches adk-python, where `if self.scopes` is false for an empty list.
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
