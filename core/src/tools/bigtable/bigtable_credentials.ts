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

/** Session-state key under which a Bigtable token is cached. */
export const BIGTABLE_TOKEN_CACHE_KEY = 'bigtable_token_cache';

/** Scopes a Bigtable credential requests when the caller names none. */
export const BIGTABLE_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];

/**
 * Bigtable credentials configuration for Google API tools.
 *
 * It takes the same three combinations as
 * {@link BaseGoogleCredentialsConfig}, then fills in the Bigtable admin and
 * data scopes and the Bigtable token cache key. The scopes are a default, so
 * an `externalAccessTokenKey` config also ends up with them even though
 * passing `scopes` alongside that key is rejected.
 *
 * @experimental Do not use this in production; it may change or be removed.
 */
@experimental
export class BigtableCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: BaseGoogleCredentialsConfigOptions) {
    super(options);
    if (!this.scopes?.length) {
      this.scopes = [...BIGTABLE_DEFAULT_SCOPE];
    }
    this.tokenCacheKey = BIGTABLE_TOKEN_CACHE_KEY;
  }
}
