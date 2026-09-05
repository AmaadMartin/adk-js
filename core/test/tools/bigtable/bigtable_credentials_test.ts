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
import {Compute, OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

const BIGTABLE_SCOPES = [
  'https://www.googleapis.com/auth/bigtable.admin',
  'https://www.googleapis.com/auth/bigtable.data',
];

const CREDENTIALS_CONFLICT =
  'If credentials are provided, externalAccessTokenKey, clientId,' +
  ' clientSecret, and scopes must not be provided.';
const NO_MODE =
  'Must provide one of credentials, externalAccessTokenKey, or clientId' +
  ' and clientSecret pair.';

/** An authorized-user client, the shape the config harvests an identity from. */
function userClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
  });
}

function expectInvalid(build: () => unknown, message: string): void {
  expect(build).toThrow(InputValidationError);
  expect(build).toThrow(new InputValidationError(message));
}

describe('BigtableCredentialsConfig', () => {
  it('defaults the scopes of a client id and secret pair', () => {
    const config = new BigtableCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.clientId).toBe('abc');
    expect(config.clientSecret).toBe('def');
    expect(config.credentials).toBeUndefined();
    expect(config.scopes).toEqual(BIGTABLE_SCOPES);
    expect(config.tokenCacheKey).toBe(BIGTABLE_TOKEN_CACHE_KEY);
  });

  it('harvests no identity from a client that carries no OAuth details', () => {
    const credentials = new Compute();

    const config = new BigtableCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual(BIGTABLE_SCOPES);
    expect(config.tokenCacheKey).toBe('bigtable_token_cache');
  });

  it('adopts the identity of an authorized-user client', () => {
    const credentials = userClient();
    credentials.setCredentials({scope: 'fake_scope'});

    const config = new BigtableCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual(['fake_scope']);
    expect(config.tokenCacheKey).toBe('bigtable_token_cache');
  });

  it('rejects options naming no authentication mode', () => {
    expectInvalid(() => new BigtableCredentialsConfig(), NO_MODE);
  });

  it('rejects a client id without a client secret', () => {
    expectInvalid(
      () => new BigtableCredentialsConfig({clientId: 'abc'}),
      NO_MODE,
    );
  });

  it('rejects credentials combined with a client id and secret', () => {
    expectInvalid(
      () =>
        new BigtableCredentialsConfig({
          credentials: userClient(),
          clientId: 'abc',
          clientSecret: 'def',
        }),
      CREDENTIALS_CONFLICT,
    );
  });

  it('keeps the scopes the caller asked for', () => {
    const scopes = ['https://www.googleapis.com/auth/cloud-platform'];

    const config = new BigtableCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes,
    });

    expect(config.scopes).toEqual(scopes);
  });

  it('defaults the scopes of an external access token key', () => {
    const config = new BigtableCredentialsConfig({
      externalAccessTokenKey: 'my_bigtable_token',
    });

    expect(config.externalAccessTokenKey).toBe('my_bigtable_token');
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual(BIGTABLE_SCOPES);
    expect(config.tokenCacheKey).toBe('bigtable_token_cache');
  });

  it('defaults the scopes when the caller passes an empty list', () => {
    const config = new BigtableCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: [],
    });

    expect(config.scopes).toEqual(BIGTABLE_SCOPES);
  });

  it('keeps the scopes already granted to an authorized-user client', () => {
    const credentials = userClient();
    credentials.setCredentials({
      scope:
        'https://www.googleapis.com/auth/cloud-platform' +
        ' https://www.googleapis.com/auth/bigtable.data',
    });

    const config = new BigtableCredentialsConfig({credentials});

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
  });

  it('gives each config its own scope list', () => {
    const options = {clientId: 'abc', clientSecret: 'def'};
    const first = new BigtableCredentialsConfig(options);
    const second = new BigtableCredentialsConfig(options);

    first.scopes?.push('https://www.googleapis.com/auth/cloud-platform');

    expect(first.scopes).toHaveLength(3);
    expect(second.scopes).toEqual(BIGTABLE_SCOPES);
    expect(BIGTABLE_DEFAULT_SCOPE).toHaveLength(2);
  });
});
