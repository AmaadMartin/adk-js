/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/integrations/gcs/test_gcs_credentials.py`.
 */

import {
  GCS_DEFAULT_SCOPE,
  GCS_TOKEN_CACHE_KEY,
  GcsCredentialsConfig,
  InputValidationError,
} from '@google/adk';
import {JWT, UserRefreshClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

describe('GcsCredentialsConfig', () => {
  it('test_gcs_credentials_config_client_id_secret', () => {
    const config = new GcsCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.clientId).toBe('abc');
    expect(config.clientSecret).toBe('def');
    expect(config.scopes).toEqual(GCS_DEFAULT_SCOPE);
    expect(config.credentials).toBeUndefined();
    expect(config.tokenCacheKey).toBe(GCS_TOKEN_CACHE_KEY);
  });

  it('test_gcs_credentials_config_existing_creds', () => {
    // A service account, which no consent flow can replace and which carries
    // no OAuth2 client of its own.
    const credentials = new JWT({email: 'sa@example.com', key: 'key'});

    const config = new GcsCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    // adk-python leaves the scopes of a non-user credential unset, then the
    // GCS subclass fills the default in. So does this port.
    expect(config.scopes).toEqual(GCS_DEFAULT_SCOPE);
  });

  it('test_gcs_credentials_config_oauth2_creds', () => {
    const credentials = new UserRefreshClient({
      clientId: 'oauth_client_id',
      clientSecret: 'oauth_client_secret',
      refreshToken: 'refresh',
    });
    credentials.setCredentials({scope: 'fake_scope'});

    const config = new GcsCredentialsConfig({credentials});

    expect(config.clientId).toBe('oauth_client_id');
    expect(config.clientSecret).toBe('oauth_client_secret');
    expect(config.scopes).toEqual(['fake_scope']);
  });

  it('test_gcs_credentials_config_validation_errors', () => {
    expect(() => new GcsCredentialsConfig({})).toThrow(InputValidationError);

    expect(() => new GcsCredentialsConfig({clientId: 'abc'})).toThrow(
      InputValidationError,
    );

    const credentials = new JWT({email: 'sa@example.com', key: 'key'});
    expect(
      () =>
        new GcsCredentialsConfig({
          credentials,
          clientId: 'abc',
          clientSecret: 'def',
        }),
    ).toThrow(InputValidationError);
  });
});
