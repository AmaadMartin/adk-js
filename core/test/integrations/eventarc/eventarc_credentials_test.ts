/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The credentials config check. adk-python has no counterpart: its
 * `EventarcCredentialsConfig` is an empty subclass of
 * `BaseGoogleCredentialsConfig`, which validates through pydantic.
 *
 * A field is "missing" when it is absent or blank. These tests use blank
 * values, which the types permit, so that no case needs a cast.
 */

import {
  EventarcToolset,
  InputValidationError,
  validateEventarcCredentialsConfig,
  type AuthorizedUserCredentials,
  type EventarcCredentialsConfig,
  type ServiceAccountCredentials,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A complete service-account key. Neither value is a real credential. */
const SERVICE_ACCOUNT: ServiceAccountCredentials = {
  client_email: 'publisher@example.iam.gserviceaccount.com',
  private_key: 'placeholder',
};

/** A complete authorized-user credential. No value is a real credential. */
const AUTHORIZED_USER: AuthorizedUserCredentials = {
  type: 'authorized_user',
  client_id: 'placeholder-id',
  client_secret: 'placeholder',
  refresh_token: 'placeholder',
};

const KEY_FILE = '/tmp/key.json';

describe('validateEventarcCredentialsConfig', () => {
  it('accepts an empty config, meaning Application Default Credentials', () => {
    expect(() => validateEventarcCredentialsConfig({})).not.toThrow();
  });

  it('accepts a key file on its own', () => {
    expect(() =>
      validateEventarcCredentialsConfig({keyFilename: KEY_FILE}),
    ).not.toThrow();
  });

  it('accepts a complete service account key', () => {
    expect(() =>
      validateEventarcCredentialsConfig({credentials: SERVICE_ACCOUNT}),
    ).not.toThrow();
  });

  it('accepts a complete authorized user credential', () => {
    expect(() =>
      validateEventarcCredentialsConfig({credentials: AUTHORIZED_USER}),
    ).not.toThrow();
  });

  it('accepts scopes alongside one credential source', () => {
    expect(() =>
      validateEventarcCredentialsConfig({
        credentials: SERVICE_ACCOUNT,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }),
    ).not.toThrow();
  });

  it('rejects a config naming both credentials and a key file', () => {
    const config: EventarcCredentialsConfig = {
      credentials: SERVICE_ACCOUNT,
      keyFilename: KEY_FILE,
    };

    expect(() => validateEventarcCredentialsConfig(config)).toThrow(
      InputValidationError,
    );
    expect(() => validateEventarcCredentialsConfig(config)).toThrow(
      'names two credential sources',
    );
  });

  it.each(['client_id', 'client_secret', 'refresh_token'] as const)(
    'rejects an authorized user credential with a blank %s',
    (field) => {
      expect(() =>
        validateEventarcCredentialsConfig({
          credentials: {...AUTHORIZED_USER, [field]: ''},
        }),
      ).toThrow(`an authorized_user credential missing ${field}`);
    },
  );

  it.each(['client_email', 'private_key'] as const)(
    'rejects a service account key with a blank %s',
    (field) => {
      expect(() =>
        validateEventarcCredentialsConfig({
          credentials: {...SERVICE_ACCOUNT, [field]: ''},
        }),
      ).toThrow(`a service account key missing ${field}`);
    },
  );

  it('treats a whitespace-only value as missing', () => {
    expect(() =>
      validateEventarcCredentialsConfig({
        credentials: {...SERVICE_ACCOUNT, private_key: '   '},
      }),
    ).toThrow('a service account key missing private_key');
  });

  it('names every missing field at once', () => {
    expect(() =>
      validateEventarcCredentialsConfig({
        credentials: {
          type: 'authorized_user',
          client_id: '',
          client_secret: '',
          refresh_token: '',
        },
      }),
    ).toThrow('missing client_id, client_secret, refresh_token');
  });
});

describe('EventarcToolset credentials check', () => {
  it('rejects a config naming two sources when the toolset is built', () => {
    expect(
      () =>
        new EventarcToolset({
          credentialsConfig: {
            credentials: SERVICE_ACCOUNT,
            keyFilename: KEY_FILE,
          },
        }),
    ).toThrow('names two credential sources');
  });

  it('rejects an incomplete credential when the toolset is built', () => {
    expect(
      () =>
        new EventarcToolset({
          credentialsConfig: {
            credentials: {...SERVICE_ACCOUNT, private_key: ''},
          },
        }),
    ).toThrow('a service account key missing private_key');
  });

  it('builds with no credentials config at all', () => {
    expect(() => new EventarcToolset()).not.toThrow();
  });
});
