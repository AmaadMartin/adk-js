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

/** Session-state key the resolved Bigtable credential is cached under. */
export const BIGTABLE_TOKEN_CACHE_KEY = 'bigtable_token_cache';

/** Scopes requested when the configuration names none of its own. */
export const BIGTABLE_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];

/**
 * Options accepted by {@link BigtableCredentialsConfig}.
 *
 * `tokenCacheKey` is fixed at {@link BIGTABLE_TOKEN_CACHE_KEY} and is not a
 * caller's to set, so it is omitted here rather than accepted and discarded.
 * adk-python keeps it private for the same reason.
 */
export type BigtableCredentialsConfigOptions = Omit<
  BaseGoogleCredentialsConfigOptions,
  'tokenCacheKey'
>;

/**
 * How a Bigtable tool obtains credentials (Experimental).
 *
 * Adds the Bigtable scopes and token-cache key to
 * {@link BaseGoogleCredentialsConfig}; the credential modes and their
 * validation are inherited unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class BigtableCredentialsConfig extends BaseGoogleCredentialsConfig {
  declare readonly scopes: string[];

  constructor(options: BigtableCredentialsConfigOptions) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default can only be applied once it has
    // run. adk-python applies it in the same order.
    super({...options, tokenCacheKey: BIGTABLE_TOKEN_CACHE_KEY});

    if (!this.scopes?.length) {
      this.scopes = [...BIGTABLE_DEFAULT_SCOPE];
    }
  }
}
