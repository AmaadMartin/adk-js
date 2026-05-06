/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BigQueryCredentialsConfig {
  /**
   * Explicit credentials to use (e.g., Service Account JWT, OAuth2Client, or GoogleAuth instance).
   * If set, these credentials will be used directly.
   */
  credentials?: unknown;

  /**
   * The key to retrieve the access token from `toolContext.state`.
   * If provided, the tool will fetch the access token from the state and use it.
   */
  externalAccessTokenKey?: string;

  /**
   * OAuth2 client ID for interactive authentication flow.
   */
  clientId?: string;

  /**
   * OAuth2 client secret for interactive authentication flow.
   */
  clientSecret?: string;

  /**
   * Scopes required for BigQuery access.
   * Defaults to [
   *   'https://www.googleapis.com/auth/bigquery',
   *   'https://www.googleapis.com/auth/dataplex.read-write'
   * ]
   */
  scopes?: string[];
}

export const BIGQUERY_TOKEN_CACHE_KEY = 'bigquery_token_cache';
export const BIGQUERY_SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/dataplex.read-write',
];
export const BIGQUERY_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
];
