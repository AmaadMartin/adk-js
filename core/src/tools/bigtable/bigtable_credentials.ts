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

/** Session-state key the Bigtable tools cache their token under. */
export const BIGTABLE_TOKEN_CACHE_KEY = 'bigtable_token_cache';

/** The scopes the Bigtable tools request when the caller names none. */
export const BIGTABLE_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];

/** Options accepted by {@link BigtableCredentialsConfig}. */
export type BigtableCredentialsConfigOptions = Omit<
  BaseGoogleCredentialsConfigOptions,
  'tokenCacheKey'
>;

/**
 * The scopes to ask the end user for.
 *
 * The base config rejects scopes alongside existing credentials or an
 * external access token, and reads them off the credential instead, so the
 * Bigtable default applies only to a consent flow.
 */
function bigtableScopes(
  options: BigtableCredentialsConfigOptions,
): string[] | undefined {
  if (options.credentials || options.externalAccessTokenKey) {
    return options.scopes;
  }
  return options.scopes?.length ? options.scopes : BIGTABLE_DEFAULT_SCOPE;
}

/**
 * How the Bigtable tools obtain credentials (Experimental).
 *
 * It is {@link BaseGoogleCredentialsConfig} with the Bigtable admin and data
 * scopes as its default, and with its own token cache key so that a Bigtable
 * consent does not satisfy another Google toolset.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class BigtableCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: BigtableCredentialsConfigOptions) {
    super({
      ...options,
      scopes: bigtableScopes(options),
      tokenCacheKey: BIGTABLE_TOKEN_CACHE_KEY,
    });
  }
}
