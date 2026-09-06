/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {StorageOptions} from '@google-cloud/storage';

import {
  BaseGoogleCredentialsConfig,
  type GoogleCredentialsConfigOptions,
} from '../../tools/_google_credentials.js';
import {experimental} from '../../utils/experimental.js';

/** Session-state key every Cloud Storage credential is cached under. */
export const GCS_TOKEN_CACHE_KEY = 'gcs_token_cache';

/** The OAuth scope the Cloud Storage tools request when the caller names none. */
export const GCS_DEFAULT_SCOPE: readonly string[] = [
  'https://www.googleapis.com/auth/devstorage.full_control',
];

/**
 * How a Cloud Storage tool obtains credentials (experimental).
 *
 * The config defaults its scopes to {@link GCS_DEFAULT_SCOPE} and caches the
 * resolved token under {@link GCS_TOKEN_CACHE_KEY}, so a Cloud Storage consent
 * never satisfies another Google toolset that asked for other scopes. Every
 * credential mode and every validation rule is inherited unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class GCSCredentialsConfig extends BaseGoogleCredentialsConfig {
  constructor(options: GoogleCredentialsConfigOptions = {}) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default can only be applied once it has
    // run. adk-python applies it in the same order, which is why the default
    // reaches every credential mode and not just a consent flow.
    super(options);
    if (!this.scopes?.length) {
      // Copied, so that two configs never share one mutable array.
      this.scopes = [...GCS_DEFAULT_SCOPE];
    }
    this.tokenCacheKey = GCS_TOKEN_CACHE_KEY;
  }
}

/**
 * How a {@link GcsToolset} authenticates to Cloud Storage.
 *
 * The fields are taken from the Cloud Storage SDK's own `StorageOptions`, so
 * they forward to the client verbatim. Supply a key file, inline credentials
 * or an `AuthClient`; omit all three to use Application Default Credentials.
 *
 * This is the client-level counterpart of {@link GCSCredentialsConfig}, which
 * ports adk-python's interactive end-user handshake. That flow needs
 * `GoogleTool`, which adk-js does not have, so the toolset authenticates the
 * Cloud Storage client instead.
 */
export type GcsCredentialsConfig = Pick<
  StorageOptions,
  'scopes' | 'keyFilename' | 'authClient' | 'credentials'
>;
