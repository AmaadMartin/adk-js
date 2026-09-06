/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {
  BaseGoogleCredentialsConfig,
  BaseGoogleCredentialsConfigOptions,
} from '../google_credentials.js';

/** Session-state key every Bigtable credential is cached under. */
export const BIGTABLE_TOKEN_CACHE_KEY = 'bigtable_token_cache';

/** Scopes requested when the caller names none. */
export const BIGTABLE_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];

/**
 * How a Cloud Bigtable tool obtains credentials (Experimental).
 *
 * It is {@link BaseGoogleCredentialsConfig} with the Bigtable scopes and cache
 * key filled in. Every credential mode and every validation rule is inherited
 * unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class BigtableCredentialsConfig extends BaseGoogleCredentialsConfig {
  /** Always set, unlike the inherited field. Defaults per instance. */
  declare readonly scopes: string[];
  /** Always {@link BIGTABLE_TOKEN_CACHE_KEY}. The caller cannot change it. */
  declare readonly tokenCacheKey: string;

  constructor(options: BaseGoogleCredentialsConfigOptions) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default is applied after it runs.
    super(options);

    this.scopes = this.scopes?.length
      ? this.scopes
      : [...BIGTABLE_DEFAULT_SCOPE];
    this.tokenCacheKey = BIGTABLE_TOKEN_CACHE_KEY;
  }
}
