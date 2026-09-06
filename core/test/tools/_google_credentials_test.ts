/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseGoogleCredentialsConfig, InputValidationError} from '@google/adk';
import {Compute, OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';
import {isOAuth2UserClient} from '../../src/tools/_google_credentials.js';

const CREDENTIALS_CONFLICT =
  'If credentials are provided, externalAccessTokenKey, clientId,' +
  ' clientSecret, and scopes must not be provided.';
const EXTERNAL_TOKEN_CONFLICT =
  'If externalAccessTokenKey is provided, clientId, clientSecret, and' +
  ' scopes must not be provided.';
const NO_MODE =
  'Must provide one of credentials, externalAccessTokenKey, or clientId' +
  ' and clientSecret pair.';

/** An authorized-user client, the shape the config harvests an identity from. */
function userClient(clientId?: string, clientSecret?: string): OAuth2Client {
  return new OAuth2Client({clientId, clientSecret});
}

/** A client whose access token was granted the given space-delimited scopes. */
function userClientWithScope(scope: string): OAuth2Client {
  const client = userClient('test_client_id', 'test_client_secret');
  client.setCredentials({scope});
  return client;
}

function expectInvalid(build: () => unknown, message: string): void {
  expect(build).toThrow(InputValidationError);
  expect(build).toThrow(new InputValidationError(message));
}

describe('isOAuth2UserClient', () => {
  it('accepts a client carrying a client id', () => {
    expect(isOAuth2UserClient(userClient('test_client_id'))).toBe(true);
  });

  it('accepts a client carrying only a client secret', () => {
    expect(isOAuth2UserClient(userClient(undefined, 'test_secret'))).toBe(true);
  });

  it('rejects a client carrying neither, even when it extends OAuth2Client', () => {
    const metadataClient = new Compute();
    expect(metadataClient).toBeInstanceOf(OAuth2Client);
    expect(isOAuth2UserClient(metadataClient)).toBe(false);
  });
});

describe('BaseGoogleCredentialsConfig validation', () => {
  const credentials = userClient('test_client_id', 'test_client_secret');

  it('rejects credentials combined with an external access token key', () => {
    expectInvalid(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials,
          externalAccessTokenKey: 'token_key',
        }),
      CREDENTIALS_CONFLICT,
    );
  });

  it('rejects credentials combined with a client id', () => {
    expectInvalid(
      () =>
        new BaseGoogleCredentialsConfig({credentials, clientId: 'other_id'}),
      CREDENTIALS_CONFLICT,
    );
  });

  it('rejects credentials combined with a client secret', () => {
    expectInvalid(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials,
          clientSecret: 'other_secret',
        }),
      CREDENTIALS_CONFLICT,
    );
  });

  it('rejects credentials combined with scopes', () => {
    expectInvalid(
      () => new BaseGoogleCredentialsConfig({credentials, scopes: ['a']}),
      CREDENTIALS_CONFLICT,
    );
  });

  it('accepts credentials combined with an empty scope list', () => {
    const config = new BaseGoogleCredentialsConfig({credentials, scopes: []});
    expect(config.credentials).toBe(credentials);
  });

  it('rejects an external access token key combined with a client id', () => {
    expectInvalid(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'token_key',
          clientId: 'test_client_id',
        }),
      EXTERNAL_TOKEN_CONFLICT,
    );
  });

  it('rejects an external access token key combined with a client secret', () => {
    expectInvalid(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'token_key',
          clientSecret: 'test_client_secret',
        }),
      EXTERNAL_TOKEN_CONFLICT,
    );
  });

  it('rejects an external access token key combined with scopes', () => {
    expectInvalid(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'token_key',
          scopes: ['a'],
        }),
      EXTERNAL_TOKEN_CONFLICT,
    );
  });

  it('accepts an external access token key combined with an empty scope list', () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'token_key',
      scopes: [],
    });
    expect(config.externalAccessTokenKey).toBe('token_key');
  });

  it('rejects options naming no authentication mode', () => {
    expectInvalid(() => new BaseGoogleCredentialsConfig(), NO_MODE);
  });

  it('rejects a client id without a client secret', () => {
    expectInvalid(
      () => new BaseGoogleCredentialsConfig({clientId: 'test_client_id'}),
      NO_MODE,
    );
  });

  it('rejects a client secret without a client id', () => {
    expectInvalid(
      () =>
        new BaseGoogleCredentialsConfig({clientSecret: 'test_client_secret'}),
      NO_MODE,
    );
  });

  it('rejects an empty client id', () => {
    expectInvalid(
      () =>
        new BaseGoogleCredentialsConfig({
          clientId: '',
          clientSecret: 'test_client_secret',
        }),
      NO_MODE,
    );
  });
});

describe('BaseGoogleCredentialsConfig construction', () => {
  it('keeps a client id and secret pair, and defaults nothing', () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });

    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toBeUndefined();
    expect(config.tokenCacheKey).toBeUndefined();
  });

  it('harvests the identity of an authorized-user client', () => {
    const credentials = userClient('test_client_id', 'test_client_secret');

    const config = new BaseGoogleCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toBeUndefined();
  });

  it('splits the granted scopes of an authorized-user client', () => {
    const credentials = userClientWithScope(
      'https://www.googleapis.com/auth/cloud-platform' +
        ' https://www.googleapis.com/auth/spanner.data',
    );

    const config = new BaseGoogleCredentialsConfig({credentials});

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/spanner.data',
    ]);
  });

  it('drops the empty entries of a padded scope string', () => {
    const config = new BaseGoogleCredentialsConfig({
      credentials: userClientWithScope('  '),
    });

    expect(config.scopes).toEqual([]);
  });

  it('harvests nothing from a client that carries no OAuth identity', () => {
    const credentials = new Compute();
    credentials.setCredentials({
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    });

    const config = new BaseGoogleCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toBeUndefined();
  });
});
