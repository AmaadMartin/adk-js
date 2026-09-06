/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BIGQUERY_SCOPES,
  BigQueryCredentialsConfig,
  InputValidationError,
} from '@google/adk';
import {JWT, OAuth2Client, PassThroughClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';
// By path, because `isOAuth2Client` is deliberately not public API.
import {isOAuth2Client} from '../../../src/integrations/bigquery/bigquery_credentials.js';

const CLIENT_ID = 'test_client_id';
const CLIENT_SECRET = 'test_client_secret';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const MISSING_PAIR_MESSAGE =
  'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
  'and clientSecret pair.';
const CREDENTIALS_EXCLUSIVE_MESSAGE =
  'If credentials are provided, externalAccessTokenKey, clientId, ' +
  'clientSecret, and scopes must not be provided.';
const EXTERNAL_TOKEN_EXCLUSIVE_MESSAGE =
  'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
  'scopes must not be provided.';

/**
 * An authorized-user client that carries its own OAuth identity, as
 * `google.oauth2.credentials.Credentials` does in adk-python.
 */
function makeAuthorizedUserClient(scope: string): OAuth2Client {
  const client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  client.setCredentials({access_token: 'test_token', scope});
  return client;
}

// adk-python's `test_invalid_property_raises_error` covers pydantic's
// `extra="forbid"`. TypeScript rejects an unknown option at compile time
// through excess-property checking, so it has no runtime counterpart here.

describe('BIGQUERY_SCOPES', () => {
  it('requests BigQuery and Dataplex read-write, in that order', () => {
    expect(BIGQUERY_SCOPES).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });
});

describe('isOAuth2Client', () => {
  it('accepts a client of the OAuth2 family', () => {
    expect(isOAuth2Client(new OAuth2Client())).toBe(true);
    expect(isOAuth2Client(new JWT({email: 'a@b.com', key: 'k'}))).toBe(true);
  });

  it('rejects a client outside the OAuth2 family', () => {
    expect(isOAuth2Client(new PassThroughClient())).toBe(false);
  });
});

describe('BigQueryCredentialsConfig', () => {
  it('keeps an application credential and applies the BigQuery scopes', () => {
    const credentials = new PassThroughClient();

    const config = new BigQueryCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });

  it('adopts the identity and scopes of an authorized-user client', () => {
    const credentials = makeAuthorizedUserClient(CALENDAR_SCOPE);

    const config = new BigQueryCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual([CALENDAR_SCOPE]);
  });

  it('splits the granted scopes of a client on whitespace', () => {
    const credentials = makeAuthorizedUserClient(
      `${CALENDAR_SCOPE} ${DRIVE_SCOPE}`,
    );

    const config = new BigQueryCredentialsConfig({credentials});

    expect(config.scopes).toEqual([CALENDAR_SCOPE, DRIVE_SCOPE]);
  });

  it('adopts the scopes of a client that names no OAuth identity', () => {
    const credentials = new OAuth2Client();
    credentials.setCredentials({
      access_token: 'test_token',
      scope: DRIVE_SCOPE,
    });

    const config = new BigQueryCredentialsConfig({credentials});

    expect(config.clientId).toBeUndefined();
    expect(config.scopes).toEqual([DRIVE_SCOPE]);
  });

  it('applies the BigQuery scopes to a service account client', () => {
    const credentials = new JWT({
      email: 'test@example.iam.gserviceaccount.com',
      key: 'test_key',
    });

    const config = new BigQueryCredentialsConfig({credentials});

    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });

  it('applies the BigQuery scopes to a client id and secret pair', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });

  it('keeps the scopes the caller names', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: [BIGQUERY_SCOPES[0], DRIVE_SCOPE],
    });

    expect(config.scopes).toEqual([BIGQUERY_SCOPES[0], DRIVE_SCOPE]);
  });

  it('applies the BigQuery scopes when the caller names an empty list', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: [],
    });

    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });

  it('applies the BigQuery scopes to an external access token key', () => {
    const config = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'my_access_token',
    });

    expect(config.externalAccessTokenKey).toBe('my_access_token');
    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });

  it('never hands two configurations the same scopes array', () => {
    const first = new BigQueryCredentialsConfig({externalAccessTokenKey: 'k'});
    const second = new BigQueryCredentialsConfig({externalAccessTokenKey: 'k'});

    expect(first.scopes).not.toBe(second.scopes);
    expect(first.scopes).not.toBe(BIGQUERY_SCOPES);
    expect(first.scopes).toEqual(second.scopes);
  });

  it('copies the scopes the caller names, so a later mutation cannot reach it', () => {
    const scopes = [DRIVE_SCOPE];

    const config = new BigQueryCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes,
    });
    scopes.push(CALENDAR_SCOPE);

    expect(config.scopes).toEqual([DRIVE_SCOPE]);
  });

  it('rejects a client id without a client secret', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientId: CLIENT_ID}),
    ).toThrowError(MISSING_PAIR_MESSAGE);
  });

  it('rejects a client secret without a client id', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientSecret: CLIENT_SECRET}),
    ).toThrowError(MISSING_PAIR_MESSAGE);
  });

  it('rejects an empty configuration', () => {
    expect(() => new BigQueryCredentialsConfig({})).toThrowError(
      MISSING_PAIR_MESSAGE,
    );
  });

  it('reports an invalid configuration as an InputValidationError', () => {
    expect(() => new BigQueryCredentialsConfig({})).toThrowError(
      InputValidationError,
    );
  });

  it('rejects credentials combined with a client id', () => {
    expect(
      () =>
        new BigQueryCredentialsConfig({
          credentials: new PassThroughClient(),
          clientId: CLIENT_ID,
        }),
    ).toThrowError(CREDENTIALS_EXCLUSIVE_MESSAGE);
  });

  it('rejects credentials combined with scopes', () => {
    expect(
      () =>
        new BigQueryCredentialsConfig({
          credentials: new PassThroughClient(),
          scopes: [DRIVE_SCOPE],
        }),
    ).toThrowError(CREDENTIALS_EXCLUSIVE_MESSAGE);
  });

  it('rejects credentials combined with an external access token key', () => {
    expect(
      () =>
        new BigQueryCredentialsConfig({
          credentials: new PassThroughClient(),
          externalAccessTokenKey: 'my_access_token',
        }),
    ).toThrowError(CREDENTIALS_EXCLUSIVE_MESSAGE);
  });

  it('rejects an external access token key combined with a client id', () => {
    expect(
      () =>
        new BigQueryCredentialsConfig({
          externalAccessTokenKey: 'my_access_token',
          clientId: CLIENT_ID,
        }),
    ).toThrowError(EXTERNAL_TOKEN_EXCLUSIVE_MESSAGE);
  });

  it('rejects an external access token key combined with scopes', () => {
    expect(
      () =>
        new BigQueryCredentialsConfig({
          externalAccessTokenKey: 'my_access_token',
          scopes: [DRIVE_SCOPE],
        }),
    ).toThrowError(EXTERNAL_TOKEN_EXCLUSIVE_MESSAGE);
  });

  it('accepts an empty scopes list alongside an external access token key', () => {
    const config = new BigQueryCredentialsConfig({
      externalAccessTokenKey: 'my_access_token',
      scopes: [],
    });

    expect(config.scopes).toEqual(BIGQUERY_SCOPES);
  });
});
