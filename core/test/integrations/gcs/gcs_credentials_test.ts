/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  GCS_DEFAULT_SCOPE,
  GCS_TOKEN_CACHE_KEY,
  GCSCredentialsConfig,
  InputValidationError,
} from '@google/adk';
import {Compute, OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

const CREDENTIALS_CONFLICT =
  'If credentials are provided, externalAccessTokenKey, clientId,' +
  ' clientSecret, and scopes must not be provided.';
const NO_MODE =
  'Must provide one of credentials, externalAccessTokenKey, or clientId' +
  ' and clientSecret pair.';

/** A metadata-server client: an auth client that carries no OAuth identity. */
function genericClient(): Compute {
  return new Compute();
}

/** An authorized-user client granted the given space-delimited scopes. */
function oauth2Client(scope?: string): OAuth2Client {
  const client = new OAuth2Client({
    clientId: 'oauth_client_id',
    clientSecret: 'oauth_client_secret',
  });
  if (scope !== undefined) {
    client.setCredentials({scope});
  }
  return client;
}

// The cases in this block are ported from adk-python
// tests/unittests/integrations/gcs/test_gcs_credentials.py @ main, and keep
// the Python test names.
describe('GCSCredentialsConfig', () => {
  it('test_gcs_credentials_config_client_id_secret', () => {
    const config = new GCSCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.clientId).toBe('abc');
    expect(config.clientSecret).toBe('def');
    expect(config.scopes).toEqual(GCS_DEFAULT_SCOPE);
    expect(config.credentials).toBeUndefined();
  });

  it('test_gcs_credentials_config_existing_creds', () => {
    const credentials = genericClient();

    const config = new GCSCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
  });

  it('test_gcs_credentials_config_oauth2_creds', () => {
    const credentials = oauth2Client('fake_scope');

    const config = new GCSCredentialsConfig({credentials});

    expect(config.clientId).toBe('oauth_client_id');
    expect(config.clientSecret).toBe('oauth_client_secret');
    expect(config.scopes).toEqual(['fake_scope']);
  });

  it.each([
    ['no authentication mode at all', {}],
    ['a client id without a client secret', {clientId: 'abc'}],
  ])(
    'test_gcs_credentials_config_validation_errors: rejects %s',
    (_name, options) => {
      expect(() => new GCSCredentialsConfig(options)).toThrow(
        InputValidationError,
      );
      expect(() => new GCSCredentialsConfig(options)).toThrow(
        new InputValidationError(NO_MODE),
      );
    },
  );

  it('test_gcs_credentials_config_validation_errors: rejects credentials beside a client id and secret', () => {
    const build = () =>
      new GCSCredentialsConfig({
        credentials: genericClient(),
        clientId: 'abc',
        clientSecret: 'def',
      });

    expect(build).toThrow(InputValidationError);
    expect(build).toThrow(new InputValidationError(CREDENTIALS_CONFLICT));
  });
});

describe('GCSCredentialsConfig constants', () => {
  it('pins the Cloud Storage default scope', () => {
    expect(GCS_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/devstorage.full_control',
    ]);
  });

  it('pins the Cloud Storage token cache key', () => {
    expect(GCS_TOKEN_CACHE_KEY).toBe('gcs_token_cache');
  });
});

describe('GCSCredentialsConfig token cache key', () => {
  it('is set for a consent flow', () => {
    const config = new GCSCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.tokenCacheKey).toBe('gcs_token_cache');
  });

  it('is set for a pre-built client', () => {
    const config = new GCSCredentialsConfig({credentials: genericClient()});

    expect(config.tokenCacheKey).toBe('gcs_token_cache');
  });

  it('is set for an external access token key', () => {
    const config = new GCSCredentialsConfig({
      externalAccessTokenKey: 'my_gcs_token',
    });

    expect(config.tokenCacheKey).toBe('gcs_token_cache');
  });
});

describe('GCSCredentialsConfig default scopes', () => {
  it('keeps the scopes the caller named', () => {
    const config = new GCSCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
    });

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/devstorage.read_only',
    ]);
  });

  it('applies the default in the external access token mode', () => {
    const config = new GCSCredentialsConfig({
      externalAccessTokenKey: 'my_gcs_token',
    });

    expect(config.scopes).toEqual(GCS_DEFAULT_SCOPE);
  });

  it('applies the default for a client carrying no OAuth identity', () => {
    const config = new GCSCredentialsConfig({credentials: genericClient()});

    expect(config.scopes).toEqual(GCS_DEFAULT_SCOPE);
  });

  it('applies the default for a client whose token granted no scope', () => {
    const config = new GCSCredentialsConfig({credentials: oauth2Client('')});

    expect(config.scopes).toEqual(GCS_DEFAULT_SCOPE);
  });

  it('gives each config its own array, and never shares the constant', () => {
    const first = new GCSCredentialsConfig({
      externalAccessTokenKey: 'my_gcs_token',
    });
    const second = new GCSCredentialsConfig({
      externalAccessTokenKey: 'my_gcs_token',
    });

    expect(first.scopes).not.toBe(second.scopes);
    expect(first.scopes).not.toBe(GCS_DEFAULT_SCOPE);
  });
});

describe('GCSCredentialsConfig inheritance', () => {
  it('is a BaseGoogleCredentialsConfig carrying the base fields', () => {
    const config: BaseGoogleCredentialsConfig = new GCSCredentialsConfig({
      externalAccessTokenKey: 'my_gcs_token',
    });

    expect(config).toBeInstanceOf(BaseGoogleCredentialsConfig);
    expect(config.externalAccessTokenKey).toBe('my_gcs_token');
    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
  });
});
