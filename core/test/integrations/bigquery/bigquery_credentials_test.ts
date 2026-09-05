/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_credentials.py`. The
 * ported cases keep their Python names.
 *
 * `test_invalid_property_raises_error` is not ported: TypeScript rejects an
 * unknown constructor option at compile time, so there is no runtime guard to
 * exercise. `test_empty_configuration_raises_error` passes `{}` because the
 * options object is required here.
 */

import {Compute, OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

import {
  BIGQUERY_DEFAULT_SCOPE,
  BIGQUERY_SCOPES,
  BIGQUERY_TOKEN_CACHE_KEY,
  BigQueryCredentialsConfig,
} from '@google/adk/integrations/bigquery/index.js';

/** The message every incomplete configuration is rejected with. */
const MISSING_SOURCE_MESSAGE =
  'Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.';

describe('BigQueryCredentialsConfig', () => {
  it('test_valid_credentials_object_auth_credentials', () => {
    // A `Compute` client is the counterpart of Python's plain
    // `google.auth.credentials.Credentials`: it carries no OAuth client id or
    // secret of its own.
    const authCreds = new Compute();

    const config = new BigQueryCredentialsConfig({credentials: authCreds});

    expect(config.credentials).toBe(authCreds);
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('test_valid_credentials_object_oauth2_credentials', () => {
    const oauth2Creds = new OAuth2Client({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });
    oauth2Creds.setCredentials({
      access_token: 'test_token',
      scope: 'https://www.googleapis.com/auth/calendar',
    });

    const config = new BigQueryCredentialsConfig({credentials: oauth2Creds});

    expect(config.credentials).toBe(oauth2Creds);
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
  });

  it('test_valid_client_id_secret_pair_default_scope', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('test_valid_client_id_secret_pair_w_scope', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: [
        'https://www.googleapis.com/auth/bigquery',
        'https://www.googleapis.com/auth/drive',
      ],
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/drive',
    ]);
  });

  it('test_valid_client_id_secret_pair_w_empty_scope', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: [],
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('test_missing_client_secret_raises_error', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientId: 'test_client_id'}),
    ).toThrow(MISSING_SOURCE_MESSAGE);
  });

  it('test_missing_client_id_raises_error', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientSecret: 'test_client_secret'}),
    ).toThrow(MISSING_SOURCE_MESSAGE);
  });

  it('test_empty_configuration_raises_error', () => {
    expect(() => new BigQueryCredentialsConfig({})).toThrow(
      MISSING_SOURCE_MESSAGE,
    );
  });
});

describe('BigQueryCredentialsConfig token cache and slot', () => {
  it('always caches under the BigQuery key', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'id',
      clientSecret: 'secret',
    });
    expect(config.tokenCacheKey).toBe(BIGQUERY_TOKEN_CACHE_KEY);
    expect(BIGQUERY_TOKEN_CACHE_KEY).toBe('bigquery_token_cache');
  });

  it('derives the credential slot from the defaulted scopes', () => {
    const defaulted = new BigQueryCredentialsConfig({
      clientId: 'id',
      clientSecret: 'secret',
    });
    const explicit = new BigQueryCredentialsConfig({
      clientId: 'id',
      clientSecret: 'secret',
      scopes: [...BIGQUERY_SCOPES],
    });
    // Both configs ask for the same scopes, so one consent serves both.
    expect(defaulted.credentialKey).toBe(explicit.credentialKey);
    expect(defaulted.credentialKey).toContain(BIGQUERY_SCOPES[0]);
  });

  it('keeps a credential slot the caller named', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'id',
      clientSecret: 'secret',
      credentialKey: 'my_slot',
    });
    expect(config.credentialKey).toBe('my_slot');
  });

  it('exports the BigQuery-only scope alongside the full set', () => {
    // adk-python exports both. They differ, so neither is dropped.
    expect(BIGQUERY_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigquery',
    ]);
    expect(BIGQUERY_SCOPES).not.toEqual(BIGQUERY_DEFAULT_SCOPE);
  });

  it('reads a token from session state when asked to', () => {
    const config = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'my_token',
    });
    expect(config.externalAccessTokenKey).toBe('my_token');
    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });
});
