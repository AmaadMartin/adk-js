/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OAuth2Client} from 'google-auth-library';

import {InputValidationError} from '../../errors/input_validation_error.js';
import {experimental} from '../../utils/experimental.js';

/** The session-state key the resolved BigQuery OAuth token is cached under. */
export const BIGQUERY_TOKEN_CACHE_KEY = 'bigquery_token_cache';

/** The scope requested when the caller names none. */
export const BIGQUERY_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
];

/** The options accepted by {@link BigQueryCredentialsConfig}. */
export interface BigQueryCredentialsConfigOptions {
  /**
   * An already-authorized OAuth client. When it is set, it overrides
   * `clientId`, `clientSecret` and `scopes`.
   */
  credentials?: OAuth2Client;
  /** The OAuth client id used to run the end-user authorization flow. */
  clientId?: string;
  /** The OAuth client secret used to run the end-user authorization flow. */
  clientSecret?: string;
  /** The scopes to request. Defaults to {@link BIGQUERY_DEFAULT_SCOPES}. */
  scopes?: string[];
}

/**
 * Returns the scopes an authorized client was granted.
 *
 * `google-auth-library` stores them as one space-delimited string, where
 * adk-python's `Credentials.scopes` is already a list.
 */
function grantedScopes(client: OAuth2Client): string[] {
  return client.credentials.scope?.split(/\s+/).filter(Boolean) ?? [];
}

/**
 * How a {@link BigQueryTool} obtains a credential for the current end user
 * (experimental).
 *
 * Supply either an already-authorized `credentials` client, or a `clientId`
 * and `clientSecret` pair to run the OAuth2 authorization-code flow with.
 */
@experimental
export class BigQueryCredentialsConfig {
  /**
   * The resolved OAuth client, when there is one.
   *
   * It stays mutable because {@link BigQueryCredentialsManager} writes the
   * credential it resolves back here, so a later call in the same process
   * reuses it. This mirrors adk-python.
   */
  credentials?: OAuth2Client;
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** Always non-empty: {@link BIGQUERY_DEFAULT_SCOPES} when none are given. */
  readonly scopes: string[];

  /**
   * @param options The credential source and the scopes to request.
   * @throws InputValidationError When the options name no credential source.
   */
  constructor(options: BigQueryCredentialsConfigOptions) {
    const {credentials, clientId, clientSecret} = options;
    if (!credentials && (!clientId || !clientSecret)) {
      throw new InputValidationError(
        'Must provide either credentials, or a clientId and clientSecret pair.',
      );
    }

    this.credentials = credentials;
    this.clientId = credentials ? credentials._clientId : clientId;
    this.clientSecret = credentials ? credentials._clientSecret : clientSecret;

    const scopes = credentials ? grantedScopes(credentials) : options.scopes;
    this.scopes = [...(scopes?.length ? scopes : BIGQUERY_DEFAULT_SCOPES)];
  }
}
