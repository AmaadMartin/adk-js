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
import {defaultCredentialKey} from '../google_tool_credentials.js';

/** Session-state key every Bigtable credential is cached under. */
export const BIGTABLE_TOKEN_CACHE_KEY = 'bigtable_token_cache';

/** The scopes the Bigtable tools request when the caller names none. */
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
 * How a Cloud Bigtable tool obtains credentials (Experimental).
 *
 * It is {@link BaseGoogleCredentialsConfig} with the Bigtable admin and data
 * scopes as its default, and with its own token cache key so that a Bigtable
 * consent does not satisfy another Google toolset. Every credential mode and
 * every validation rule is inherited unchanged.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class BigtableCredentialsConfig extends BaseGoogleCredentialsConfig {
  /** Always set, unlike the inherited field. Defaults per instance. */
  declare readonly scopes: string[];
  /** Always {@link BIGTABLE_TOKEN_CACHE_KEY}. The caller cannot change it. */
  declare readonly tokenCacheKey: string;

  /**
   * The slot the ADK auth plumbing keeps the OAuth credential in.
   *
   * `GoogleTool` is built on a second port of the credentials module, whose
   * config carries this key. It is the key that port derives by default, so a
   * Bigtable tool shares one slot with any other tool that asks for the same
   * client and scopes.
   */
  readonly credentialKey: string;

  constructor(options: BigtableCredentialsConfigOptions) {
    // The base validator rejects `scopes` alongside `credentials` or
    // `externalAccessTokenKey`, so the default can only be applied once it has
    // run. adk-python applies it in the same order, which is why the default
    // reaches every credential mode and not just a consent flow.
    super({...options, tokenCacheKey: BIGTABLE_TOKEN_CACHE_KEY});

    if (!this.scopes?.length) {
      this.scopes = [...BIGTABLE_DEFAULT_SCOPE];
    }

    this.credentialKey = defaultCredentialKey(this.clientId, this.scopes);
  }
}
