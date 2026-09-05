/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

import {
  BIGTABLE_DEFAULT_SCOPE,
  BIGTABLE_TOKEN_CACHE_KEY,
  BigtableCredentialsConfig,
} from '../../../src/tools/bigtable/bigtable_credentials.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';

describe('BigtableCredentialsConfig', () => {
  it('asks for the Bigtable admin and data scopes by default', () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
    expect(BIGTABLE_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
  });

  it('caches its token under the Bigtable key', () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(config.tokenCacheKey).toBe(BIGTABLE_TOKEN_CACHE_KEY);
    expect(BIGTABLE_TOKEN_CACHE_KEY).toBe('bigtable_token_cache');
  });

  it('keeps the scopes the caller names', () => {
    const scopes = ['https://www.googleapis.com/auth/bigtable.data.readonly'];

    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes,
    });

    expect(config.scopes).toEqual(scopes);
  });

  it('reads an empty scope list as unset', () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: [],
    });

    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
  });

  it('adds no scopes when the caller supplies credentials', () => {
    const config = new BigtableCredentialsConfig({
      credentials: new OAuth2Client(),
    });

    expect(config.scopes).toBeUndefined();
    expect(config.tokenCacheKey).toBe(BIGTABLE_TOKEN_CACHE_KEY);
  });

  it('adds no scopes when the host supplies an access token', () => {
    const config = new BigtableCredentialsConfig({
      externalAccessTokenKey: 'host_token',
    });

    expect(config.scopes).toBeUndefined();
  });

  it('rejects an OAuth2 client id with no secret', () => {
    expect(() => new BigtableCredentialsConfig({clientId: CLIENT_ID})).toThrow(
      /Must provide one of credentials/,
    );
  });
});
