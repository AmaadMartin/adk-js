/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  GoogleCredentialsManager,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {JWT, UserRefreshClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

import {
  BIGTABLE_DEFAULT_SCOPE,
  BIGTABLE_TOKEN_CACHE_KEY,
  BigtableCredentialsConfig,
} from '../../../src/tools/bigtable/bigtable_credentials.js';
import {googleCredentialKey} from '../../../src/tools/google_credentials.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const NARROW_SCOPES = ['https://www.googleapis.com/auth/bigtable.data'];
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
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: 'user-refresh-token',
  });
  client.setCredentials({refresh_token: 'user-refresh-token', scope});
  return client;
}

/** A cache entry in the shape adk-python's `Credentials.to_json()` writes. */
function createCacheEntry(token: string, expiry: Date): string {
  return JSON.stringify({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: 'cached-refresh-token',
    token,
    token_uri: TOKEN_URL,
    scopes: BIGTABLE_DEFAULT_SCOPE,
    expiry: expiry.toISOString(),
  });
}

describe('BigtableCredentialsConfig', () => {
  it('exposes the Bigtable scopes adk-python declares, in order', () => {
    expect(BIGTABLE_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
    expect(BIGTABLE_TOKEN_CACHE_KEY).toBe('bigtable_token_cache');
  });

  it('keeps a client id and secret, and fills in the default scopes', () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
    expect(config.credentials).toBeUndefined();
  });

  it('keeps a non-user credential and adds the default scopes', () => {
    const credentials = createServiceAccountClient();

    const config = new BigtableCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
  });

  it('takes the client and scopes off a user credential', () => {
    const config = new BigtableCredentialsConfig({
      credentials: createUserClient('fake_scope'),
    });

    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual(['fake_scope']);
  });

  it('adds the default scopes to a user credential that grants none', () => {
    const config = new BigtableCredentialsConfig({
      credentials: createUserClient(),
    });

    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
  });

  it('keeps caller-supplied scopes', () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: NARROW_SCOPES,
    });

    expect(config.scopes).toEqual(NARROW_SCOPES);
  });

  it('accepts an external access token key on its own', () => {
    const config = new BigtableCredentialsConfig({
      externalAccessTokenKey: 'user_access_token',
    });

    expect(config.externalAccessTokenKey).toBe('user_access_token');
    expect(config.scopes).toEqual(BIGTABLE_DEFAULT_SCOPE);
    expect(config.tokenCacheKey).toBe(BIGTABLE_TOKEN_CACHE_KEY);
  });

  it('uses the Bigtable cache key', () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(config.tokenCacheKey).toBe(BIGTABLE_TOKEN_CACHE_KEY);
  });

  it('gives each instance its own default scope array', () => {
    const first = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    first.scopes.push('https://www.googleapis.com/auth/cloud-platform');

    const second = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(second.scopes).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
    expect(BIGTABLE_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigtable.admin',
      'https://www.googleapis.com/auth/bigtable.data',
    ]);
  });

  it('rejects an empty configuration', () => {
    expect(() => new BigtableCredentialsConfig({})).toThrowError(
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  });

  it('rejects a client id with no client secret', () => {
    expect(
      () => new BigtableCredentialsConfig({clientId: CLIENT_ID}),
    ).toThrowError('Must provide one of credentials');
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
          externalAccessTokenKey: 'user_access_token',
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }),
    ).toThrowError(
      'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
        'scopes must not be provided.',
    );
  });
});

describe('GoogleCredentialsManager with a BigtableCredentialsConfig', () => {
  it('reads the cached credential from the Bigtable session key', async () => {
    const expiry = new Date(Date.now() + HOUR_MS);
    const manager = new GoogleCredentialsManager(
      new BigtableCredentialsConfig({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      }),
    );
    const context = createToolContext({
      bigtable_token_cache: createCacheEntry('cached-access-token', expiry),
    });

    const credentials = await manager.getValidCredentials(context);

    expect(credentials?.credentials.access_token).toBe('cached-access-token');
    expect(credentials?.credentials.scope).toBe(
      BIGTABLE_DEFAULT_SCOPE.join(' '),
    );
  });

  it('writes the granted credential to the Bigtable session key', async () => {
    const config = new BigtableCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const manager = new GoogleCredentialsManager(config);
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

    await manager.getValidCredentials(context);

    const raw = context.state.get<string>('bigtable_token_cache');
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw ?? '{}')).toMatchObject({
      token: 'granted-access-token',
      refresh_token: 'granted-refresh-token',
      scopes: BIGTABLE_DEFAULT_SCOPE,
    });
  });
});
