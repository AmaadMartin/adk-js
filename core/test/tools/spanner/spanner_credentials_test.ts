/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  SPANNER_DEFAULT_SCOPE,
  SPANNER_TOKEN_CACHE_KEY,
  SpannerCredentialsConfig,
} from '@google/adk';
import {OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

const SPANNER_SCOPES = [
  'https://www.googleapis.com/auth/spanner.admin',
  'https://www.googleapis.com/auth/spanner.data',
];

/** An authorized-user client, the shape the config harvests an identity from. */
function userClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
  });
}

describe('SpannerCredentialsConfig', () => {
  it('adopts the identity of an authorized-user client', () => {
    const credentials = userClient();

    const config = new SpannerCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBe('test_client_id');
    expect(config.clientSecret).toBe('test_client_secret');
    expect(config.scopes).toEqual(SPANNER_SCOPES);
    expect(config.tokenCacheKey).toBe('spanner_token_cache');
  });

  it('defaults the scopes of a client id and secret pair', () => {
    const config = new SpannerCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    });

    expect(config.scopes).toEqual(SPANNER_SCOPES);
    expect(config.tokenCacheKey).toBe(SPANNER_TOKEN_CACHE_KEY);
  });

  it('keeps the scopes the caller asked for', () => {
    const scopes = ['https://www.googleapis.com/auth/cloud-platform'];

    const config = new SpannerCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes,
    });

    expect(config.scopes).toEqual(scopes);
    expect(config.tokenCacheKey).toBe(SPANNER_TOKEN_CACHE_KEY);
  });

  it('defaults the scopes when the caller passes an empty list', () => {
    const config = new SpannerCredentialsConfig({
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      scopes: [],
    });

    expect(config.scopes).toEqual(SPANNER_SCOPES);
  });

  it('defaults the scopes of an external access token key', () => {
    const config = new SpannerCredentialsConfig({
      externalAccessTokenKey: 'my_spanner_token',
    });

    expect(config.externalAccessTokenKey).toBe('my_spanner_token');
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual(SPANNER_SCOPES);
    expect(config.tokenCacheKey).toBe(SPANNER_TOKEN_CACHE_KEY);
  });

  it('keeps the scopes already granted to an authorized-user client', () => {
    const credentials = userClient();
    credentials.setCredentials({
      scope:
        'https://www.googleapis.com/auth/cloud-platform' +
        ' https://www.googleapis.com/auth/spanner.data',
    });

    const config = new SpannerCredentialsConfig({credentials});

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/spanner.data',
    ]);
  });

  it('gives each config its own scope list', () => {
    const options = {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    };
    const first = new SpannerCredentialsConfig(options);
    const second = new SpannerCredentialsConfig(options);

    first.scopes?.push('https://www.googleapis.com/auth/cloud-platform');

    expect(first.scopes).toHaveLength(3);
    expect(second.scopes).toEqual(SPANNER_SCOPES);
    expect(SPANNER_DEFAULT_SCOPE).toHaveLength(2);
  });

  it('rejects invalid options through the base class', () => {
    const build = () =>
      new SpannerCredentialsConfig({
        credentials: userClient(),
        clientId: 'other_id',
      });

    expect(build).toThrow(InputValidationError);
    expect(build).toThrow(
      new InputValidationError(
        'If credentials are provided, externalAccessTokenKey, clientId,' +
          ' clientSecret, and scopes must not be provided.',
      ),
    );
  });
});
