/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BIGQUERY_DEFAULT_SCOPES,
  BigQueryCredentialsConfig,
  InputValidationError,
} from '@google/adk';
import {OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

describe('BigQueryCredentialsConfig', () => {
  it('adopts the identity and the scopes of an authorized client', () => {
    const client = new OAuth2Client({
      clientId: 'client-from-oauth-client',
      clientSecret: 'secret-from-oauth-client',
    });
    client.setCredentials({
      access_token: 'access-token',
      scope:
        'https://www.googleapis.com/auth/bigquery https://www.googleapis.com/auth/calendar',
    });

    const config = new BigQueryCredentialsConfig({credentials: client});

    expect(config.credentials).toBe(client);
    expect(config.clientId).toEqual('client-from-oauth-client');
    expect(config.clientSecret).toEqual('secret-from-oauth-client');
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/calendar',
    ]);
  });

  it('stores a client id, client secret and scopes as given', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    expect(config.credentials).toBeUndefined();
    expect(config.clientId).toEqual('client-id');
    expect(config.clientSecret).toEqual('client-secret');
    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
  });

  it('defaults the scopes when none are given', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    expect(config.scopes).toEqual(BIGQUERY_DEFAULT_SCOPES);
  });

  it('defaults the scopes when an empty array is given', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: [],
    });

    expect(config.scopes).toEqual(BIGQUERY_DEFAULT_SCOPES);
  });

  it('defaults the scopes when the authorized client granted none', () => {
    const client = new OAuth2Client({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    client.setCredentials({access_token: 'access-token'});

    const config = new BigQueryCredentialsConfig({credentials: client});

    expect(config.scopes).toEqual(BIGQUERY_DEFAULT_SCOPES);
  });

  it('rejects a client id without a client secret', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientId: 'client-id'}),
    ).toThrow(InputValidationError);
  });

  it('rejects a client secret without a client id', () => {
    expect(
      () => new BigQueryCredentialsConfig({clientSecret: 'client-secret'}),
    ).toThrow(InputValidationError);
  });

  it('rejects options that name no credential source', () => {
    expect(() => new BigQueryCredentialsConfig({})).toThrow(
      new InputValidationError(
        'Must provide either credentials, or a clientId and clientSecret pair.',
      ),
    );
  });

  it('copies the scopes the caller passed', () => {
    const scopes = ['https://www.googleapis.com/auth/calendar'];
    const config = new BigQueryCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes,
    });

    scopes.push('https://www.googleapis.com/auth/drive');

    expect(config.scopes).toEqual(['https://www.googleapis.com/auth/calendar']);
  });

  it('copies the default scopes rather than aliasing the constant', () => {
    const config = new BigQueryCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    expect(config.scopes).not.toBe(BIGQUERY_DEFAULT_SCOPES);
  });
});
