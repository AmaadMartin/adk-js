/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BIGTABLE_DEFAULT_SCOPE,
  BIGTABLE_TOKEN_CACHE_KEY,
  BigtableCredentialsConfig,
  Context,
  GoogleCredentialsManager,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {JWT, UserRefreshClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

import {googleCredentialKey} from '../../../src/tools/google_credentials.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const FUNCTION_CALL_ID = 'test-function-call-id';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const HOUR_MS = 3600000;

function createToolContext(state: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'test-user',
        state,
      }),
      pluginManager: new PluginManager([]),
    }),
    functionCallId: FUNCTION_CALL_ID,
  });
}

/** A service account credential, which no consent flow can replace. */
function createServiceAccountClient(): JWT {
  return new JWT({
    email: 'service-account@example.iam.gserviceaccount.com',
    key: 'unused-private-key',
  });
}

/** A user credential, the kind a consent flow mints. */
function createUserClient(scope?: string): UserRefreshClient {
  const client = new UserRefreshClient({
    clientId: 'oauth-client-id',
    clientSecret: 'oauth-client-secret',
    refreshToken: 'user-refresh-token',
  });
  client.setCredentials({
    access_token: 'user-access-token',
    refresh_token: 'user-refresh-token',
    expiry_date: Date.now() + HOUR_MS,
    scope,
  });
  return client;
}

describe('BigtableCredentialsConfig constants', () => {
  it('names the Bigtable scopes in adk-python order', () => {
    expect(BIGTABLE_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
  });

  it('names the Bigtable token cache key', () => {
    expect(BIGTABLE_TOKEN_CACHE_KEY).toBe('bigtable_token_cache');
  });
});

describe('BigtableCredentialsConfig', () => {
  it('keeps the OAuth2 client and defaults the scopes', () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
    expect(config.credentials).toBeUndefined();
  });

  it('keeps a non-user credential and lifts no OAuth2 client off it', () => {
    const credentials = createServiceAccountClient();

    const config = new BigtableCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
  });

  it('lifts the client and scopes off a user credential', () => {
    const credentials = createUserClient('fake_scope');

    const config = new BigtableCredentialsConfig({credentials});

    expect(config.clientId).toBe('oauth-client-id');
    expect(config.clientSecret).toBe('oauth-client-secret');
    expect(config.scopes).toEqual(['fake_scope']);
  });

  it('defaults the scopes for a user credential that granted none', () => {
    const config = new BigtableCredentialsConfig({
      credentials: createUserClient(),
    });

    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
  });

  it('preserves caller-supplied scopes', () => {
    const scopes = ['https://www.googleapis.com/auth/bigtable.data'];

    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes,
    });

    expect(config.scopes).toEqual(scopes);
  });

  it('accepts an external access token key on its own', () => {
    const config = new BigtableCredentialsConfig({
      externalAccessTokenKey: 'host_access_token',
    });

    expect(config.externalAccessTokenKey).toBe('host_access_token');
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
    expect(config.tokenCacheKey).toBe(BIGTABLE_TOKEN_CACHE_KEY);
  });

  it('pins the token cache key in every credential mode', () => {
    const modes = [
      new BigtableCredentialsConfig({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      }),
      new BigtableCredentialsConfig({credentials: createUserClient()}),
      new BigtableCredentialsConfig({externalAccessTokenKey: 'host_token'}),
    ];

    for (const config of modes) {
      expect(config.tokenCacheKey).toBe(BIGTABLE_TOKEN_CACHE_KEY);
    }
  });

  it('gives each instance its own scope array', () => {
    const first = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const second = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    first.scopes.push('https://www.googleapis.com/auth/extra');

    expect(second.scopes).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
    expect(BIGTABLE_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
  });

  it('rejects options that name no credential mode', () => {
    expect(() => new BigtableCredentialsConfig({})).toThrowError(
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  });

  it('rejects a client id without a client secret', () => {
    expect(
      () => new BigtableCredentialsConfig({clientId: CLIENT_ID}),
    ).toThrowError(
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  });

  it('rejects credentials combined with an OAuth2 client', () => {
    expect(
      () =>
        new BigtableCredentialsConfig({
          credentials: createServiceAccountClient(),
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }),
    ).toThrowError(
      'If credentials are provided, externalAccessTokenKey, clientId, ' +
        'clientSecret, and scopes must not be provided.',
    );
  });

  it('rejects an external access token key combined with an OAuth2 client', () => {
    expect(
      () =>
        new BigtableCredentialsConfig({
          externalAccessTokenKey: 'host_access_token',
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }),
    ).toThrowError(
      'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
        'scopes must not be provided.',
    );
  });
});

describe('GoogleCredentialsManager with BigtableCredentialsConfig', () => {
  it('reads a cached credential from the Bigtable cache key', async () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const context = createToolContext({
      [BIGTABLE_TOKEN_CACHE_KEY]: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: 'cached-refresh-token',
        token: 'cached-access-token',
        token_uri: TOKEN_URL,
        scopes: BIGTABLE_DEFAULT_SCOPE,
        expiry: new Date(Date.now() + HOUR_MS).toISOString(),
      }),
    });

    const credentials = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(context);

    expect(credentials?.credentials.access_token).toBe('cached-access-token');
    expect(credentials?.credentials.scope).toBe(
      BIGTABLE_DEFAULT_SCOPE.join(' '),
    );
  });

  it('writes a granted credential to the Bigtable cache key', async () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const authResponse: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        accessToken: 'granted-access-token',
        refreshToken: 'granted-refresh-token',
      },
    };
    const context = createToolContext({
      [`temp:${googleCredentialKey(CLIENT_ID, BIGTABLE_DEFAULT_SCOPE)}`]:
        authResponse,
    });

    await new GoogleCredentialsManager(config).getValidCredentials(context);

    const raw = context.state.get<string>(BIGTABLE_TOKEN_CACHE_KEY);
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw ?? '{}')).toMatchObject({
      token: 'granted-access-token',
      refresh_token: 'granted-refresh-token',
      scopes: BIGTABLE_DEFAULT_SCOPE,
    });
  });
});
