/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  GoogleCredentialsConfigOptions,
  defaultCredentialKey,
} from '../../tools/google_tool_credentials.js';
import {experimental} from '../../utils/experimental.js';

/** The session-state key every BigQuery credential is cached under. */
export const BIGQUERY_TOKEN_CACHE_KEY = 'bigquery_token_cache';

/** The scopes the BigQuery tools request when the caller names none. */
export const BIGQUERY_SCOPES = [
  'https://www.googleapis.com/auth/bigquery',
  'https://www.googleapis.com/auth/dataplex.read-write',
];

/** BigQuery alone, without the catalog access `search_catalog` needs. */
export const BIGQUERY_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/bigquery',
];

/**
 * Options accepted by {@link BigQueryCredentialsConfig}.
 *
 * `tokenCacheKey` is fixed at {@link BIGQUERY_TOKEN_CACHE_KEY} and is not a
 * caller's to set, so it is omitted rather than accepted and discarded.
 */
export type BigQueryCredentialsConfigOptions = Omit<
  GoogleCredentialsConfigOptions,
  'tokenCacheKey'
>;

/**
 * How a BigQuery tool obtains credentials (Experimental).
 *
 * It is {@link BaseGoogleCredentialsConfig} with {@link BIGQUERY_SCOPES} as
 * its default and its own token cache key, so a BigQuery consent does not
 * satisfy another Google toolset. Every credential mode and every validation
 * rule is inherited unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class BigQueryCredentialsConfig extends BaseGoogleCredentialsConfig {
  /** Always set, unlike the inherited field. Defaults per instance. */
  declare readonly scopes: string[];
  /** Always {@link BIGQUERY_TOKEN_CACHE_KEY}. The caller cannot change it. */
  declare readonly tokenCacheKey: string;

  /**
   * The slot the ADK auth plumbing keeps the OAuth credential in.
   *
   * It is derived again here because the default scopes are applied after the
   * base constructor has already derived a key from an empty scope list.
   */
  readonly credentialKey: string;

  constructor(options: BigQueryCredentialsConfigOptions) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default can only be applied once it has
    // run. adk-python applies it in the same order, which is why the default
    // reaches every credential mode and not just a consent flow.
    super({...options, tokenCacheKey: BIGQUERY_TOKEN_CACHE_KEY});

    if (!this.scopes?.length) {
      this.scopes = [...BIGQUERY_SCOPES];
    }
    this.credentialKey =
      options.credentialKey ?? defaultCredentialKey(this.clientId, this.scopes);
  }
}
