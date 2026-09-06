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
import {
  BaseGoogleCredentialsConfig as GoogleCredentialsConfig,
  type BaseGoogleCredentialsConfigOptions,
} from '../../tools/google_credentials.js';
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
 * This one is built on `tools/_google_credentials.js`.
 * {@link GcsCredentialsConfig} is the same port on
 * `tools/google_credentials.js`, which is the module {@link GoogleTool} reads.
 * Pass that one to {@link GcsAdminToolset}.
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
 * It is `BaseGoogleCredentialsConfig` with the Cloud Storage full control
 * scope as its default, and with its own token cache key so that a Cloud
 * Storage consent does not satisfy another Google toolset. Every credential
 * mode and every validation rule is inherited unchanged.
 *
 * This is the config {@link GcsAdminToolset} takes, because it and
 * {@link GoogleTool} read the same credential module.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class GcsCredentialsConfig extends GoogleCredentialsConfig {
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

/**
 * How a {@link GcsToolset} authenticates to Cloud Storage.
 *
 * The fields are taken from the Cloud Storage SDK's own `StorageOptions`, so
 * they forward to the client verbatim. Supply a key file, inline credentials
 * or an `AuthClient`; omit all three to use Application Default Credentials.
 *
 * This is the client-level counterpart of the two configs above, which port
 * adk-python's interactive end-user handshake. `GcsToolset` authenticates the
 * Cloud Storage client rather than running that handshake, so it takes this
 * type. {@link GcsAdminToolset} runs the handshake and takes
 * {@link GcsCredentialsConfig}.
 */
export type GcsClientCredentialsConfig = Pick<
  StorageOptions,
  'scopes' | 'keyFilename' | 'authClient' | 'credentials'
>;
