/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {
  BaseGoogleCredentialsConfig,
  type GoogleCredentialsConfigOptions,
} from '../_google_credentials.js';

/** Key under which a resolved Bigtable token is cached in tool context state. */
export const BIGTABLE_TOKEN_CACHE_KEY = 'bigtable_token_cache';

/** OAuth scopes the Bigtable tools request when the caller names none. */
export const BIGTABLE_DEFAULT_SCOPE: readonly string[] = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];

/**
 * How the Bigtable tools obtain credentials (experimental).
 *
 * The config defaults its scopes to {@link BIGTABLE_DEFAULT_SCOPE} and caches
 * the resolved token under {@link BIGTABLE_TOKEN_CACHE_KEY}, so Bigtable tools
 * never share a cached token with another Google toolset.
 */
@experimental
export class BigtableCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: GoogleCredentialsConfigOptions = {}) {
    super(options);
    if (!this.scopes?.length) {
      // Copied, so that no config can mutate the module-level default.
      this.scopes = [...BIGTABLE_DEFAULT_SCOPE];
    }
    this.tokenCacheKey = BIGTABLE_TOKEN_CACHE_KEY;
  }
}
