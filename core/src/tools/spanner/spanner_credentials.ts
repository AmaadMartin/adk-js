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

/** Key under which a resolved Spanner token is cached in tool context state. */
export const SPANNER_TOKEN_CACHE_KEY = 'spanner_token_cache';

/** OAuth scopes the Spanner tools request when the caller names none. */
export const SPANNER_DEFAULT_SCOPE: readonly string[] = [
  'https://www.googleapis.com/auth/spanner.admin',
  'https://www.googleapis.com/auth/spanner.data',
];

/**
 * How the Spanner tools obtain credentials (experimental).
 *
 * The config defaults its scopes to {@link SPANNER_DEFAULT_SCOPE} and caches
 * the resolved token under {@link SPANNER_TOKEN_CACHE_KEY}, so Spanner tools
 * never share a cached token with another Google toolset.
 */
@experimental
export class SpannerCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: GoogleCredentialsConfigOptions = {}) {
    super(options);
    if (!this.scopes?.length) {
      // Copied, so that two configs never share one mutable array.
      this.scopes = [...SPANNER_DEFAULT_SCOPE];
    }
    this.tokenCacheKey = SPANNER_TOKEN_CACHE_KEY;
  }
}
