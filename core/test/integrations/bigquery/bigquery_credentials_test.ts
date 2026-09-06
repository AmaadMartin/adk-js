/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BIGQUERY_DEFAULT_SCOPE,
  BIGQUERY_SCOPES,
  BIGQUERY_TOKEN_CACHE_KEY,
  BaseGoogleCredentialsConfig,
  BigQueryCredentialsConfig,
  InputValidationError,
} from '@google/adk';
import * as bigqueryEntryPoint from '@google/adk/integrations/bigquery/index.js';
import {Compute, OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

const NO_MODE =
  'Must provide one of credentials, externalAccessTokenKey, or clientId' +
  ' and clientSecret pair.';

/**
 * A client carrying no OAuth2 identity, standing in for adk-python's
 * `mock.create_autospec(google.auth.credentials.Credentials)`.
 */
function genericClient(): Compute {
  return new Compute();
}

function expectNoMode(build: () => unknown): void {
  expect(build).toThrow(InputValidationError);
  expect(build).toThrow(new InputValidationError(NO_MODE));
}

// Ported from adk-python
// tests/unittests/integrations/bigquery/test_bigquery_credentials.py @ main.
// Each `it()` string is the Python test name, verbatim. 8 of the reference's 9
// tests port. `test_invalid_property_raises_error` does not: it asserts
// pydantic's `extra="forbid"`, and the base class runs no equivalent key check,
// so no runtime assertion can observe the guarantee.
describe('BigQueryCredentialsConfig ported reference tests', () => {
  it('test_valid_credentials_object_auth_credentials', () => {
    const credentials = genericClient();

    const config = new BigQueryCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('test_valid_credentials_object_oauth2_credentials', () => {
    const credentials = new OAuth2Client({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });
    // adk-python reads `credentials.scopes`, a list. google-auth-library
    // exposes `credentials.scope`, one space-delimited string, which the base
    // class splits.
    credentials.setCredentials({
      scope: 'https://www.googleapis.com/auth/calendar',
    });

    const config = new BigQueryCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
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
    expectNoMode(
      () => new BigQueryCredentialsConfig({clientId: 'test_client_id'}),
    );
  });

  it('test_missing_client_id_raises_error', () => {
    expectNoMode(
      () => new BigQueryCredentialsConfig({clientSecret: 'test_client_secret'}),
    );
  });

  it('test_empty_configuration_raises_error', () => {
    expectNoMode(() => new BigQueryCredentialsConfig());
  });
});

describe('BigQueryCredentialsConfig constants', () => {
  it('pins the scopes adk-python requests by default', () => {
    expect(BIGQUERY_SCOPES).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('pins the single BigQuery scope, which is not the default', () => {
    expect(BIGQUERY_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigquery',
    ]);
    expect(BIGQUERY_DEFAULT_SCOPE).not.toEqual(BIGQUERY_SCOPES);
  });

  it('pins the session-state key adk-python caches under', () => {
    expect(BIGQUERY_TOKEN_CACHE_KEY).toBe('bigquery_token_cache');
  });
});

describe('BigQueryCredentialsConfig token cache key', () => {
  it('is set in the OAuth2 consent mode', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });

    expect(config.tokenCacheKey).toBe('bigquery_token_cache');
  });

  it('is set when the caller names its own scopes', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    expect(config.tokenCacheKey).toBe('bigquery_token_cache');
  });

  it('is set in the pre-built credential mode', () => {
    const config = new BigQueryCredentialsConfig({
      credentials: genericClient(),
    });

    expect(config.tokenCacheKey).toBe('bigquery_token_cache');
  });

  it('is set in the external access token mode', () => {
    const config = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'user_access_token',
    });

    expect(config.externalAccessTokenKey).toBe('user_access_token');
    expect(config.tokenCacheKey).toBe('bigquery_token_cache');
  });
});

describe('BigQueryCredentialsConfig default scopes', () => {
  it('gives two configs two arrays, neither aliasing the constant', () => {
    const first = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });
    const second = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'user_access_token',
    });

    expect(first.scopes).not.toBe(second.scopes);
    expect(first.scopes).not.toBe(BIGQUERY_SCOPES);
    first.scopes?.push('https://www.googleapis.com/auth/drive');
    expect(second.scopes).toEqual([...BIGQUERY_SCOPES]);
    expect(BIGQUERY_SCOPES).toHaveLength(2);
  });

  it('applies the default in the external access token mode', () => {
    const config = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'user_access_token',
    });

    expect(config.scopes).toEqual([...BIGQUERY_SCOPES]);
  });
});

describe('BigQueryCredentialsConfig inheritance', () => {
  it('is a BaseGoogleCredentialsConfig carrying the base fields', () => {
    const config: BaseGoogleCredentialsConfig = new BigQueryCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });

    expect(config).toBeInstanceOf(BaseGoogleCredentialsConfig);
    expect(config.externalAccessTokenKey).toBeUndefined();
    expect(config.credentials).toBeUndefined();
  });

  it('rejects a conflicting mode with the base validator message', () => {
    const build = () =>
      new BigQueryCredentialsConfig({
        credentials: genericClient(),
        clientId: 'test_client_id',
      });

    expect(build).toThrow(InputValidationError);
    expect(build).toThrow(
      new InputValidationError(
        'If credentials are provided, externalAccessTokenKey, clientId,' +
          ' clientSecret, and scopes must not be provided.',
      ),
    );
  });

  it('rejects an external access token key combined with scopes', () => {
    const build = () =>
      new BigQueryCredentialsConfig({
        externalAccessTokenKey: 'user_access_token',
        scopes: ['https://www.googleapis.com/auth/bigquery'],
      });

    expect(build).toThrow(InputValidationError);
    expect(build).toThrow(
      new InputValidationError(
        'If externalAccessTokenKey is provided, clientId, clientSecret, and' +
          ' scopes must not be provided.',
      ),
    );
  });
});

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_credentials.py`. The
 * ported cases keep their Python names.
 *
 * `test_invalid_property_raises_error` is not ported: TypeScript rejects an
 * unknown constructor option at compile time, so there is no runtime guard to
 * exercise. `test_empty_configuration_raises_error` passes `{}` because the
 * options object is required here.
 *
 * adk-python also exports `BIGQUERY_DEFAULT_SCOPE`, a BigQuery-only scope
 * list that no code path there reads. It is exported here too, and the suite
 * above pins it. The default the constructor applies is `BIGQUERY_SCOPES`,
 * pinned by `test_valid_client_id_secret_pair_default_scope` below.
 */
/** The message every incomplete configuration is rejected with. */
const MISSING_SOURCE_MESSAGE =
  'Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.';

describe('BigQueryCredentialsConfig', () => {
  it('is the class the barrel exports, reached through the subpath', () => {
    expect(bigqueryEntryPoint.BigQueryCredentialsConfig).toBe(
      BigQueryCredentialsConfig,
    );
    expect(bigqueryEntryPoint.BIGQUERY_SCOPES).toBe(BIGQUERY_SCOPES);
    expect(bigqueryEntryPoint.BIGQUERY_TOKEN_CACHE_KEY).toBe(
      BIGQUERY_TOKEN_CACHE_KEY,
    );
  });

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

  it('reads a token from session state when asked to', () => {
    const config = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'my_token',
    });
    expect(config.externalAccessTokenKey).toBe('my_token');
    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });
});
