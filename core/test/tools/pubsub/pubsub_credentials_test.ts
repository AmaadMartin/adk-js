/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/tools/pubsub/test_pubsub_credentials.py @ main

import {
  InputValidationError,
  PUBSUB_DEFAULT_SCOPE,
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
