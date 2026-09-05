/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  type GoogleCredentialsConfigOptions,
} from '../../tools/_google_credentials.js';
import {experimental} from '../../utils/experimental.js';

/** Session-state key every BigQuery credential is cached under. */
export const BIGQUERY_TOKEN_CACHE_KEY = 'bigquery_token_cache';

/** The OAuth scopes the BigQuery tools request when the caller names none. */
export const BIGQUERY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/dataplex.read-write',
];

/**
 * How a BigQuery tool obtains credentials (experimental).
 *
 * The config defaults its scopes to {@link BIGQUERY_SCOPES} and caches the
 * resolved token under {@link BIGQUERY_TOKEN_CACHE_KEY}, so a BigQuery consent
 * never satisfies another Google toolset that asked for other scopes. Every
 * credential mode and every validation rule is inherited unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class BigQueryCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: GoogleCredentialsConfigOptions = {}) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default can only be applied once it has
    // run. adk-python applies it in the same order, which is why the default
    // reaches every credential mode and not just a consent flow.
    super(options);
    if (!this.scopes?.length) {
      // Copied, so that two configs never share one mutable array.
      this.scopes = [...BIGQUERY_SCOPES];
    }
    this.tokenCacheKey = BIGQUERY_TOKEN_CACHE_KEY;
  }
}
