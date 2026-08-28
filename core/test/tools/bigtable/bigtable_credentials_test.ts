/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BIGTABLE_DEFAULT_SCOPE,
  BIGTABLE_TOKEN_CACHE_KEY,
  BigtableCredentialsConfig,
  InputValidationError,
} from '@google/adk';
import {OAuth2Client, PassThroughClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

describe('BigtableCredentialsConfig constants', () => {
  it('names the Bigtable admin and data scopes and the cache key', () => {
    expect(BIGTABLE_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
    expect(BIGTABLE_TOKEN_CACHE_KEY).toBe('bigtable_token_cache');
  });
});

describe('BigtableCredentialsConfig', () => {
  it('keeps a client id and secret and fills in the default scopes', () => {
    const config = new BigtableCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.clientId).toBe('abc');
    expect(config.clientSecret).toBe('def');
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
    expect(config.credentials).toBeUndefined();
  });

  it('pins the token cache key to the Bigtable one', () => {
    const config = new BigtableCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.tokenCacheKey).toBe(BIGTABLE_TOKEN_CACHE_KEY);
  });

  it('keeps a credential that carries no OAuth identity', () => {
    const credentials = new PassThroughClient();

    const config = new BigtableCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
  });

  it('adopts the identity and granted scopes of an OAuth2 credential', () => {
    const credentials = new OAuth2Client({
      clientId: 'oauth_client_id',
      clientSecret: 'oauth_client_secret',
    });
    // The auth library stores the granted scope as one space-delimited
    // string, where adk-python holds a list.
    credentials.setCredentials({scope: 'fake_scope another_scope'});

    const config = new BigtableCredentialsConfig({credentials});

    expect(config.clientId).toBe('oauth_client_id');
    expect(config.clientSecret).toBe('oauth_client_secret');
    expect(config.scopes).toEqual(['fake_scope', 'another_scope']);
  });

  it('keeps the scopes the caller named', () => {
    const config = new BigtableCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: ['https://www.googleapis.com/auth/bigtable.data'],
    });

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
  });

  it('fills in the default scopes for an external access token key', () => {
    const config = new BigtableCredentialsConfig({
      externalAccessTokenKey: 'bigtable_access_token',
    });

    expect(config.externalAccessTokenKey).toBe('bigtable_access_token');
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
  });

  it('fills in the default scopes when the caller names an empty list', () => {
    const config = new BigtableCredentialsConfig({
      credentials: new PassThroughClient(),
      scopes: [],
    });

    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
  });

  it('gives each config its own scopes array', () => {
    const first = new BigtableCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });
    const second = new BigtableCredentialsConfig({
      clientId: 'ghi',
      clientSecret: 'jkl',
    });

    expect(first.scopes).toEqual(second.scopes);
    expect(first.scopes).not.toBe(second.scopes);
    expect(first.scopes).not.toBe(BIGTABLE_DEFAULT_SCOPE);
  });
});

describe('BigtableCredentialsConfig validation', () => {
  it('rejects an empty configuration', () => {
    expect(() => new BigtableCredentialsConfig({})).toThrow(
      new InputValidationError(
        'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
          'and clientSecret pair.',
      ),
    );
  });

  it('rejects a client id without a client secret', () => {
    expect(() => new BigtableCredentialsConfig({clientId: 'abc'})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a credential combined with a client id and secret', () => {
    expect(
      () =>
        new BigtableCredentialsConfig({
          credentials: new PassThroughClient(),
          clientId: 'abc',
          clientSecret: 'def',
        }),
    ).toThrow(
      new InputValidationError(
        'If credentials are provided, externalAccessTokenKey, clientId, ' +
          'clientSecret, and scopes must not be provided.',
      ),
    );
  });
});
