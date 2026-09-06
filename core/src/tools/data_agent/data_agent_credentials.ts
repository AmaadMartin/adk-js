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

/** Session-state key every data agent credential is cached under. */
export const DATA_AGENT_TOKEN_CACHE_KEY = 'data_agent_token_cache';

/** The OAuth scope the data agent tools request when the caller names none. */
export const DATA_AGENT_DEFAULT_SCOPE: readonly string[] = [
  'https://www.googleapis.com/auth/bigquery',
];

/**
 * How a data agent tool obtains credentials (experimental).
 *
 * The config defaults its scopes to {@link DATA_AGENT_DEFAULT_SCOPE} and
 * caches the resolved token under {@link DATA_AGENT_TOKEN_CACHE_KEY}, so a
 * data agent consent never satisfies another Google toolset that asked for
 * other scopes. Every credential mode and every validation rule is inherited
 * unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class DataAgentCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: GoogleCredentialsConfigOptions = {}) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default can only be applied once it has
    // run. adk-python applies it in the same order, which is why the default
    // reaches every credential mode and not just a consent flow.
    super(options);
    if (!this.scopes?.length) {
      // Copied, so that two configs never share one mutable array.
      this.scopes = [...DATA_AGENT_DEFAULT_SCOPE];
    }
    this.tokenCacheKey = DATA_AGENT_TOKEN_CACHE_KEY;
  }
}
