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

/** Session-state key every Pub/Sub credential is cached under. */
export const PUBSUB_TOKEN_CACHE_KEY = 'pubsub_token_cache';

/** The OAuth scope the Pub/Sub tools request when the caller names none. */
export const PUBSUB_DEFAULT_SCOPE: readonly string[] = [
  'https://www.googleapis.com/auth/pubsub',
];

/**
 * How a Pub/Sub tool obtains credentials (experimental).
 *
 * The config defaults its scopes to {@link PUBSUB_DEFAULT_SCOPE} and caches
 * the resolved token under {@link PUBSUB_TOKEN_CACHE_KEY}, so a Pub/Sub
 * consent never satisfies another Google toolset that asked for other scopes.
 * Every credential mode and every validation rule is inherited unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class PubSubCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: GoogleCredentialsConfigOptions = {}) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default can only be applied once it has
    // run. adk-python applies it in the same order, which is why the default
    // reaches every credential mode and not just a consent flow.
    super(options);
    if (!this.scopes?.length) {
      // Copied, so that two configs never share one mutable array.
      this.scopes = [...PUBSUB_DEFAULT_SCOPE];
    }
    this.tokenCacheKey = PUBSUB_TOKEN_CACHE_KEY;
  }
}
