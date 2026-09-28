/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  InputValidationError,
  PUBSUB_DEFAULT_SCOPE,
  PUBSUB_TOKEN_CACHE_KEY,
  PubSubCredentialsConfig,
} from '@google/adk';
import {Compute, OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

const NO_MODE =
  'Must provide one of credentials, externalAccessTokenKey, or clientId' +
  ' and clientSecret pair.';
const CREDENTIALS_CONFLICT =
  'If credentials are provided, externalAccessTokenKey, clientId,' +
  ' clientSecret, and scopes must not be provided.';

/**
 * A client carrying no OAuth2 identity, standing in for adk-python's
 * `mock.create_autospec(Credentials)`.
 */
function genericClient(): Compute {
  return new Compute();
}

// The cases in this block are ported from adk-python
// tests/unittests/tools/pubsub/test_pubsub_credentials.py @ main, and keep the
// Python test names.
describe('PubSubCredentialsConfig', () => {
  it('test_pubsub_credentials_config_client_id_secret', () => {
    const config = new PubSubCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.clientId).toBe('abc');
    expect(config.clientSecret).toBe('def');
    expect(config.scopes).toEqual([...PUBSUB_DEFAULT_SCOPE]);
    expect(config.credentials).toBeUndefined();
  });

  it('test_pubsub_credentials_config_existing_creds', () => {
    const credentials = genericClient();

    const config = new PubSubCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
  });

  it('test_pubsub_credentials_config_oauth2_creds', () => {
    const credentials = new OAuth2Client({
      clientId: 'oauth_client_id',
      clientSecret: 'oauth_client_secret',
    });
    // adk-python reads `credentials.scopes`, a list. google-auth-library
    // exposes `credentials.scope`, one space-delimited string, which the base
    // class splits.
    credentials.setCredentials({scope: 'fake_scope'});

    const config = new PubSubCredentialsConfig({credentials});

    expect(config.clientId).toBe('oauth_client_id');
    expect(config.clientSecret).toBe('oauth_client_secret');
    expect(config.scopes).toEqual(['fake_scope']);
  });

  it.each([{clientId: undefined}, {clientId: 'abc'}])(
    'test_pubsub_credentials_config_validation_errors [clientId=$clientId]',
    ({clientId}) => {
      const build = () => new PubSubCredentialsConfig({clientId});

      expect(build).toThrow(InputValidationError);
      expect(build).toThrow(new InputValidationError(NO_MODE));
    },
  );

  it('test_pubsub_credentials_config_both_credentials_and_client_provided', () => {
    const build = () =>
      new PubSubCredentialsConfig({
        credentials: genericClient(),
        clientId: 'abc',
        clientSecret: 'def',
      });

    expect(build).toThrow(InputValidationError);
    expect(build).toThrow(new InputValidationError(CREDENTIALS_CONFLICT));
  });
});

describe('PubSubCredentialsConfig constants', () => {
  it('pins the scope adk-python requests', () => {
    expect(PUBSUB_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/pubsub',
    ]);
  });

  it('pins the session-state key adk-python caches under', () => {
    expect(PUBSUB_TOKEN_CACHE_KEY).toBe('pubsub_token_cache');
  });
});

describe('PubSubCredentialsConfig token cache key', () => {
  it('is set in the OAuth2 consent mode', () => {
    const config = new PubSubCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.tokenCacheKey).toBe('pubsub_token_cache');
  });

  it('is set in the pre-built credential mode', () => {
    const config = new PubSubCredentialsConfig({credentials: new Compute()});

    expect(config.tokenCacheKey).toBe('pubsub_token_cache');
  });

  it('is set in the external access token mode', () => {
    const config = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });

    expect(config.tokenCacheKey).toBe('pubsub_token_cache');
  });
});

describe('PubSubCredentialsConfig default scopes', () => {
  it('keeps scopes the caller named', () => {
    const config = new PubSubCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
  });

  it('applies the default in the external access token mode', () => {
    const config = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });

    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/pubsub']);
  });

  it('applies the default to a client carrying no OAuth identity', () => {
    const config = new PubSubCredentialsConfig({credentials: new Compute()});

    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/pubsub']);
  });

  it('gives two configs two arrays, so neither can mutate the other', () => {
    const first = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });
    const second = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });

    expect(first.scopes).not.toBe(second.scopes);
    expect(first.scopes).not.toBe(PUBSUB_DEFAULT_SCOPE);
  });
});

describe('PubSubCredentialsConfig inheritance', () => {
  it('carries the fields of the base config', () => {
    const base: BaseGoogleCredentialsConfig = new PubSubCredentialsConfig({
      externalAccessTokenKey: 'my_pubsub_token',
    });

    expect(base.externalAccessTokenKey).toBe('my_pubsub_token');
    expect(base.credentials).toBeUndefined();
    expect(base.clientId).toBeUndefined();
    expect(base.clientSecret).toBeUndefined();
  });
});
