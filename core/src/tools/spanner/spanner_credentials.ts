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

/**
 * Session-state key the resolved Spanner credential is cached under.
 *
 * adk-python writes its cached credential under this exact key, so a session
 * written by either SDK is readable by the other.
 */
export const SPANNER_TOKEN_CACHE_KEY = 'spanner_token_cache';

/** OAuth scopes the Spanner tools request when the caller names none. */
export const SPANNER_DEFAULT_SCOPE: readonly string[] = [
  'https://www.googleapis.com/auth/spanner.admin',
  'https://www.googleapis.com/auth/spanner.data',
];

/**
 * Options for {@link SpannerCredentialsConfig}.
 *
 * `tokenCacheKey` is fixed to {@link SPANNER_TOKEN_CACHE_KEY}, so the caller
 * cannot supply one.
 */
export type SpannerCredentialsConfigOptions = Omit<
  BaseGoogleCredentialsConfigOptions,
  'tokenCacheKey'
>;

/**
 * How the Spanner tools obtain Google credentials (Experimental).
 *
 * It adds two Spanner-specific values to
 * {@link BaseGoogleCredentialsConfig}: the Spanner scope pair, applied when
 * the caller names no scopes, and a fixed token cache key that keeps a
 * resolved Spanner token apart from another toolset's cached token. The three
 * credential modes and every validation message come from the base class.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class SpannerCredentialsConfig extends BaseGoogleCredentialsConfig {
  // Redeclared so the constructor below may assign it. `declare` emits no
  // field, so the value the base constructor assigned survives.
  declare readonly scopes?: string[];

  constructor(options: SpannerCredentialsConfigOptions) {
    super({...options, tokenCacheKey: SPANNER_TOKEN_CACHE_KEY});

    // The base constructor extracts the scopes out of a supplied credential,
    // and rejects `scopes` passed next to one, so the default can only be
    // applied after it runs. The copy keeps two instances from sharing one
    // array.
    if (!this.scopes?.length) {
      this.scopes = [...SPANNER_DEFAULT_SCOPE];
    }
  }
}
