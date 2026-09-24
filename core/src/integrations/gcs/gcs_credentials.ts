/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  BaseGoogleCredentialsConfigOptions,
} from '../../tools/google_credentials.js';
import {experimental} from '../../utils/experimental.js';

/** Session-state key every Cloud Storage credential is cached under. */
export const GCS_TOKEN_CACHE_KEY = 'gcs_token_cache';

/** The scopes the Cloud Storage tools request when the caller names none. */
export const GCS_DEFAULT_SCOPE = [
  'https://www.googleapis.com/auth/devstorage.full_control',
];

/**
 * Options accepted by {@link GcsCredentialsConfig}.
 *
 * `tokenCacheKey` is fixed at {@link GCS_TOKEN_CACHE_KEY} and is not a
 * caller's to set, so it is omitted here rather than accepted and discarded.
 * adk-python keeps it private for the same reason.
 */
export type GcsCredentialsConfigOptions = Omit<
  BaseGoogleCredentialsConfigOptions,
  'tokenCacheKey'
>;

/**
 * How a Cloud Storage tool obtains credentials (Experimental).
 *
 * It is {@link BaseGoogleCredentialsConfig} with the Cloud Storage full
 * control scope as its default, and with its own token cache key so that a
 * Cloud Storage consent does not satisfy another Google toolset. Every
 * credential mode and every validation rule is inherited unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class GcsCredentialsConfig extends BaseGoogleCredentialsConfig {
  /** Always set, unlike the inherited field. Defaults per instance. */
  declare readonly scopes: string[];
  /** Always {@link GCS_TOKEN_CACHE_KEY}. The caller cannot change it. */
  declare readonly tokenCacheKey: string;

  constructor(options: GcsCredentialsConfigOptions) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default can only be applied once it has
    // run. adk-python applies it in the same order, which is why the default
    // reaches every credential mode and not just a consent flow.
    super({...options, tokenCacheKey: GCS_TOKEN_CACHE_KEY});

    if (!this.scopes?.length) {
      this.scopes = [...GCS_DEFAULT_SCOPE];
    }
  }
}
