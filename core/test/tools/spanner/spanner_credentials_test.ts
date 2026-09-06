/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  SPANNER_DEFAULT_SCOPES,
  SPANNER_TOKEN_CACHE_KEY,
  SpannerCredentialsConfig,
  SpannerCredentialsManager,
} from '@google/adk';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {CachedSpannerToken} from '../../../src/tools/spanner/spanner_credentials.js';
import {createToolContext} from './spanner_test_utils.js';

const OAUTH_CONFIG = {clientId: 'client-id', clientSecret: 'client-secret'};

/** The credential a completed OAuth flow leaves in the session state. */
function grantedCredential(
  oauth2: Record<string, unknown> = {accessToken: 'granted-token'},
): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

function accessTokenOf(client: AuthClient | undefined): string | undefined {
  return client?.credentials.access_token ?? undefined;
}

describe('SpannerCredentialsConfig', () => {
  it('defaults the scopes and the token cache key', () => {
    const config = new SpannerCredentialsConfig(OAUTH_CONFIG);
    expect(config.scopes).toEqual(SPANNER_DEFAULT_SCOPES);
    expect(config.tokenCacheKey).toBe('spanner_token_cache');
    expect(SPANNER_TOKEN_CACHE_KEY).toBe('spanner_token_cache');
  });

  it('lists the two Spanner scopes', () => {
    expect(SPANNER_DEFAULT_SCOPES).toEqual([
      'https://www.googleapis.com/auth/spanner.admin',
      'https://www.googleapis.com/auth/spanner.data',
    ]);
  });

  it('keeps explicit scopes', () => {
    const config = new SpannerCredentialsConfig({
      ...OAUTH_CONFIG,
      scopes: ['https://www.googleapis.com/auth/spanner.data'],
    });
    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/spanner.data',
    ]);
  });

  it('defaults the scopes when an empty list is given', () => {
    const config = new SpannerCredentialsConfig({...OAUTH_CONFIG, scopes: []});
    expect(config.scopes).toEqual(SPANNER_DEFAULT_SCOPES);
  });

  it('accepts an auth client on its own', () => {
    const credentials = new OAuth2Client();
    expect(new SpannerCredentialsConfig({credentials}).credentials).toBe(
      credentials,
    );
  });

  it('accepts an external access token key on its own', () => {
    const config = new SpannerCredentialsConfig({
      externalAccessTokenKey: 'token',
    });
    expect(config.externalAccessTokenKey).toBe('token');
  });

  it.each([
    {externalAccessTokenKey: 'token'},
    {clientId: 'client-id'},
    {clientSecret: 'client-secret'},
    {scopes: ['scope']},
  ])('rejects an auth client combined with %o', (extra) => {
    expect(
      () =>
        new SpannerCredentialsConfig({
          credentials: new OAuth2Client(),
          ...extra,
        }),
    ).toThrow(
      'If credentials are provided, external_access_token_key, client_id,' +
        ' client_secret, and scopes must not be provided.',
    );
  });

  it.each([
    {clientId: 'client-id'},
    {clientSecret: 'client-secret'},
    {scopes: ['scope']},
  ])('rejects an external access token key combined with %o', (extra) => {
    expect(
      () =>
        new SpannerCredentialsConfig({
          externalAccessTokenKey: 'token',
          ...extra,
        }),
    ).toThrow(
      'If external_access_token_key is provided, client_id,' +
        ' client_secret, and scopes must not be provided.',
    );
  });

  it.each([{}, {clientId: 'client-id'}, {clientSecret: 'client-secret'}])(
    'rejects an incomplete OAuth pair %o',
    (options) => {
      expect(() => new SpannerCredentialsConfig(options)).toThrow(
        'Must provide one of credentials, external_access_token_key, or' +
          ' client_id and client_secret pair.',
      );
    },
  );
});

describe('SpannerCredentialsManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the configured auth client unchanged', async () => {
    const credentials = new OAuth2Client();
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig({credentials}),
    );
    await expect(
      manager.getValidCredentials(createToolContext()),
    ).resolves.toBe(credentials);
  });

  it('reads an external access token from the session state', async () => {
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig({externalAccessTokenKey: 'my_token'}),
    );
    const client = await manager.getValidCredentials(
      createToolContext({state: {my_token: 'external-token'}}),
    );
    expect(accessTokenOf(client)).toBe('external-token');
  });

  it('reports a missing external access token', async () => {
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig({externalAccessTokenKey: 'my_token'}),
    );
    await expect(
      manager.getValidCredentials(createToolContext()),
    ).rejects.toThrow(
      'external_access_token_key is provided but no access token found in' +
        ' tool_context.state with key my_token.',
    );
  });

  it('reuses a cached token that has not expired', async () => {
    const cached: CachedSpannerToken = {
      accessToken: 'cached-token',
      expiryDate: Date.now() + 60_000,
    };
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const client = await manager.getValidCredentials(
      createToolContext({state: {[SPANNER_TOKEN_CACHE_KEY]: cached}}),
    );
    expect(accessTokenOf(client)).toBe('cached-token');
  });

  it('reuses a cached token with no expiry', async () => {
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const client = await manager.getValidCredentials(
      createToolContext({
        state: {[SPANNER_TOKEN_CACHE_KEY]: {accessToken: 'cached-token'}},
      }),
    );
    expect(accessTokenOf(client)).toBe('cached-token');
  });

  it('refreshes an expired token and re-caches it', async () => {
    const refresh = vi
      .spyOn(OAuth2Client.prototype, 'refreshAccessToken')
      .mockImplementation(async () => ({
        credentials: {access_token: 'fresh-token', expiry_date: 4102444800000},
        res: null,
      }));
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const context = createToolContext({
      state: {
        [SPANNER_TOKEN_CACHE_KEY]: {
          accessToken: 'stale-token',
          refreshToken: 'refresh-token',
          expiryDate: Date.now() - 1000,
        },
      },
    });

    const client = await manager.getValidCredentials(context);

    expect(refresh).toHaveBeenCalledOnce();
    expect(accessTokenOf(client)).toBe('fresh-token');
    expect(context.state.get(SPANNER_TOKEN_CACHE_KEY)).toEqual({
      accessToken: 'fresh-token',
      refreshToken: 'refresh-token',
      expiryDate: 4102444800000,
    });
  });

  it('caches nothing when the refresh returns no access token', async () => {
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockImplementation(
      async () => ({credentials: {}, res: null}),
    );
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const cached = {
      accessToken: 'stale-token',
      refreshToken: 'refresh-token',
      expiryDate: Date.now() - 1000,
    };
    const context = createToolContext({
      state: {[SPANNER_TOKEN_CACHE_KEY]: cached},
    });

    await expect(manager.getValidCredentials(context)).resolves.toBeInstanceOf(
      OAuth2Client,
    );
    expect(context.state.get(SPANNER_TOKEN_CACHE_KEY)).toEqual(cached);
  });

  it('falls back to the OAuth flow when the refresh fails', async () => {
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockRejectedValue(
      new Error('invalid_grant'),
    );
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const context = createToolContext({
      state: {
        [SPANNER_TOKEN_CACHE_KEY]: {
          accessToken: 'stale-token',
          refreshToken: 'refresh-token',
          expiryDate: Date.now() - 1000,
        },
      },
      functionCallId: 'call-1',
    });

    await expect(manager.getValidCredentials(context)).resolves.toBeUndefined();
    expect(context.eventActions.requestedAuthConfigs['call-1']).toBeDefined();
  });

  it('falls back to the OAuth flow when the expired token cannot be refreshed', async () => {
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const context = createToolContext({
      state: {
        [SPANNER_TOKEN_CACHE_KEY]: {
          accessToken: 'stale-token',
          expiryDate: Date.now() - 1000,
        },
      },
      functionCallId: 'call-1',
    });

    await expect(manager.getValidCredentials(context)).resolves.toBeUndefined();
    expect(context.eventActions.requestedAuthConfigs['call-1']).toBeDefined();
  });

  it('requests authorization and returns undefined while it is pending', async () => {
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const context = createToolContext({functionCallId: 'call-1'});

    await expect(manager.getValidCredentials(context)).resolves.toBeUndefined();

    const requested = context.eventActions.requestedAuthConfigs['call-1'];
    expect(requested?.credentialKey).toBe(SPANNER_TOKEN_CACHE_KEY);
    expect(requested?.authScheme).toMatchObject({
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          scopes: {
            'https://www.googleapis.com/auth/spanner.admin':
              'Access to https://www.googleapis.com/auth/spanner.admin',
            'https://www.googleapis.com/auth/spanner.data':
              'Access to https://www.googleapis.com/auth/spanner.data',
          },
        },
      },
    });
    expect(requested?.rawAuthCredential?.oauth2).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
  });

  it('builds credentials from the granted authorization and caches them', async () => {
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const context = createToolContext({
      state: {
        [`temp:${SPANNER_TOKEN_CACHE_KEY}`]: grantedCredential({
          accessToken: 'granted-token',
          refreshToken: 'granted-refresh',
          expiresAt: 4102444800000,
        }),
      },
      functionCallId: 'call-1',
    });

    const client = await manager.getValidCredentials(context);

    expect(accessTokenOf(client)).toBe('granted-token');
    expect(context.state.get(SPANNER_TOKEN_CACHE_KEY)).toEqual({
      accessToken: 'granted-token',
      refreshToken: 'granted-refresh',
      expiryDate: 4102444800000,
    });
    expect(context.eventActions.requestedAuthConfigs['call-1']).toBeUndefined();
  });

  it('caches a granted credential that carries no expiry', async () => {
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const context = createToolContext({
      state: {
        [`temp:${SPANNER_TOKEN_CACHE_KEY}`]: grantedCredential({
          accessToken: 'granted-token',
        }),
      },
      functionCallId: 'call-1',
    });

    await manager.getValidCredentials(context);

    expect(context.state.get(SPANNER_TOKEN_CACHE_KEY)).toEqual({
      accessToken: 'granted-token',
      refreshToken: undefined,
      expiryDate: undefined,
    });
  });

  it('caches the refresh token the refresh returned', async () => {
    vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockImplementation(
      async () => ({
        credentials: {
          access_token: 'fresh-token',
          refresh_token: 'rotated-refresh',
        },
        res: null,
      }),
    );
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const context = createToolContext({
      state: {
        [SPANNER_TOKEN_CACHE_KEY]: {
          accessToken: 'stale-token',
          refreshToken: 'refresh-token',
          expiryDate: Date.now() - 1000,
        },
      },
    });

    await manager.getValidCredentials(context);

    expect(context.state.get(SPANNER_TOKEN_CACHE_KEY)).toMatchObject({
      refreshToken: 'rotated-refresh',
    });
  });

  it('asks again when the granted credential carries no access token', async () => {
    const manager = new SpannerCredentialsManager(
      new SpannerCredentialsConfig(OAUTH_CONFIG),
    );
    const context = createToolContext({
      state: {[`temp:${SPANNER_TOKEN_CACHE_KEY}`]: grantedCredential({})},
      functionCallId: 'call-1',
    });

    await expect(manager.getValidCredentials(context)).resolves.toBeUndefined();
    expect(context.eventActions.requestedAuthConfigs['call-1']).toBeDefined();
  });
});
