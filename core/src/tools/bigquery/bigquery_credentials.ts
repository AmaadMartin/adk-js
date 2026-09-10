/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How the BigQuery tools authenticate.
 *
 * Ported from adk-python
 * `src/google/adk/integrations/bigquery/bigquery_credentials.py` (branch
 * `main`). adk-python's config extends `BaseGoogleCredentialsConfig`, which
 * owns an OAuth handshake that adk-js does not have yet, so this config
 * carries the authentication subset of the BigQuery client options instead.
 */

import type {CredentialBody} from 'google-auth-library';

/** OAuth scopes the BigQuery tools need, including catalog search. */
export const BIGQUERY_SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/dataplex.read-write',
];

/**
 * How the BigQuery tools authenticate.
 *
 * Every field is optional: with none of them the clients fall back to the
 * application default credentials of the process.
 */
export interface BigQueryCredentialsConfig {
  /** A service account key or an authorized user credential, in memory. */
  credentials?: CredentialBody;
  /** Path of a service account key file. */
  keyFilename?: string;
  /** OAuth scopes to request. Absent or empty means {@link BIGQUERY_SCOPES}. */
  scopes?: string[];
}

/**
 * Returns the scopes a credentials config asks for.
 *
 * An absent or empty `scopes` means the caller expressed no preference, so
 * the tools request everything they need. adk-python's `__post_init__` makes
 * the same substitution.
 *
 * @param config The caller's credentials configuration.
 * @return The scopes to request.
 */
export function resolveBigQueryScopes(
  config?: BigQueryCredentialsConfig,
): string[] {
  const scopes = config?.scopes;
  return scopes && scopes.length > 0 ? scopes : BIGQUERY_SCOPES;
}
