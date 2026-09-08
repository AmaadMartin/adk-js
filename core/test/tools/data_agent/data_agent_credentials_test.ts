/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  DATA_AGENT_DEFAULT_SCOPE,
  DATA_AGENT_TOKEN_CACHE_KEY,
  DataAgentCredentialsConfig,
  InputValidationError,
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

// adk-python has no test file for tools/data_agent/credentials.py. The cases
// in this block are adapted from adk-python
// tests/unittests/tools/pubsub/test_pubsub_credentials.py @ main, the closest
// sibling module, with the Python test names carried over and `pubsub`
// replaced by `data_agent`.
describe('DataAgentCredentialsConfig', () => {
  it('test_data_agent_credentials_config_client_id_secret', () => {
    const config = new DataAgentCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.clientId).toBe('abc');
    expect(config.clientSecret).toBe('def');
    expect(config.scopes).toEqual([...DATA_AGENT_DEFAULT_SCOPE]);
    expect(config.credentials).toBeUndefined();
  });

  it('test_data_agent_credentials_config_existing_creds', () => {
    const credentials = genericClient();

    const config = new DataAgentCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
  });

  it('test_data_agent_credentials_config_oauth2_creds', () => {
    const credentials = new OAuth2Client({
      clientId: 'oauth_client_id',
      clientSecret: 'oauth_client_secret',
    });
    // adk-python reads `credentials.scopes`, a list. google-auth-library
    // exposes `credentials.scope`, one space-delimited string, which the base
    // class splits.
    credentials.setCredentials({scope: 'fake_scope'});

    const config = new DataAgentCredentialsConfig({credentials});

    expect(config.clientId).toBe('oauth_client_id');
    expect(config.clientSecret).toBe('oauth_client_secret');
    expect(config.scopes).toEqual(['fake_scope']);
  });

  it.each([{clientId: undefined}, {clientId: 'abc'}])(
    'test_data_agent_credentials_config_validation_errors [clientId=$clientId]',
    ({clientId}) => {
      const build = () => new DataAgentCredentialsConfig({clientId});

      expect(build).toThrow(InputValidationError);
      expect(build).toThrow(new InputValidationError(NO_MODE));
    },
  );

  it('test_data_agent_credentials_config_both_credentials_and_client_provided', () => {
    const build = () =>
      new DataAgentCredentialsConfig({
        credentials: genericClient(),
        clientId: 'abc',
        clientSecret: 'def',
      });

    expect(build).toThrow(InputValidationError);
    expect(build).toThrow(new InputValidationError(CREDENTIALS_CONFLICT));
  });
});

describe('DataAgentCredentialsConfig constants', () => {
  it('pins the scope adk-python requests', () => {
    expect(DATA_AGENT_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigquery',
    ]);
  });

  it('pins the session-state key adk-python caches under', () => {
    expect(DATA_AGENT_TOKEN_CACHE_KEY).toBe('data_agent_token_cache');
  });
});

describe('DataAgentCredentialsConfig token cache key', () => {
  it('is set in the OAuth2 consent mode', () => {
    const config = new DataAgentCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.tokenCacheKey).toBe('data_agent_token_cache');
  });

  it('is set in the pre-built credential mode', () => {
    const config = new DataAgentCredentialsConfig({credentials: new Compute()});

    expect(config.tokenCacheKey).toBe('data_agent_token_cache');
  });

  it('is set in the external access token mode', () => {
    const config = new DataAgentCredentialsConfig({
      externalAccessTokenKey: 'my_data_agent_token',
    });

    expect(config.tokenCacheKey).toBe('data_agent_token_cache');
  });

  it('is set when the caller names its own scopes', () => {
    const config = new DataAgentCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    expect(config.tokenCacheKey).toBe('data_agent_token_cache');
  });
});

describe('DataAgentCredentialsConfig default scopes', () => {
  it('keeps scopes the caller named', () => {
    const config = new DataAgentCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
  });

  it('applies the default in the external access token mode', () => {
    const config = new DataAgentCredentialsConfig({
      externalAccessTokenKey: 'my_data_agent_token',
    });

    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/bigquery']);
  });

  it('applies the default to a client carrying no OAuth identity', () => {
    const config = new DataAgentCredentialsConfig({credentials: new Compute()});

    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/bigquery']);
  });

  it('gives two configs two arrays, so neither can mutate the other', () => {
    const first = new DataAgentCredentialsConfig({
      externalAccessTokenKey: 'my_data_agent_token',
    });
    const second = new DataAgentCredentialsConfig({
      externalAccessTokenKey: 'my_data_agent_token',
    });

    expect(first.scopes).not.toBe(second.scopes);
    expect(first.scopes).not.toBe(DATA_AGENT_DEFAULT_SCOPE);
  });
});

describe('DataAgentCredentialsConfig inheritance', () => {
  it('carries the fields of the base config', () => {
    const base: BaseGoogleCredentialsConfig = new DataAgentCredentialsConfig({
      externalAccessTokenKey: 'my_data_agent_token',
    });

    expect(base.externalAccessTokenKey).toBe('my_data_agent_token');
    expect(base.credentials).toBeUndefined();
    expect(base.clientId).toBeUndefined();
    expect(base.clientSecret).toBeUndefined();
  });
});
