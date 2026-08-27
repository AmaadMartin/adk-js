/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  Context,
  GoogleCredentialsManager,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {AuthClient, OAuth2Client, PassThroughClient} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';

const HOUR_MS = 60 * 60 * 1000;
const CACHE_KEY = 'spanner_token_cache';
const SCOPES = ['https://www.googleapis.com/auth/spanner.data'];

function makeContext(state: Record<string, unknown> = {}): Context {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u1',
    state,
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: 'fc-1'});
}

/**
 * The prototype every `OAuth2Client` shares, typed as the abstract base so a
 * stub of `getAccessToken` binds to the promise-returning signature rather
 * than the deprecated callback overload.
 */
const oauth2ClientPrototype: AuthClient = OAuth2Client.prototype;

/** An auth client holding the given token material, as an app would supply. */
function makeClient(credentials: {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
}): AuthClient {
  const client = new OAuth2Client({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });
  client.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiryDate,
    scope: credentials.scope,
  });
  return client;
}

/** Makes any client's refresh succeed with the given token and expiry. */
function stubRefresh(accessToken: string, expiryDate: number): void {
  vi.spyOn(oauth2ClientPrototype, 'getAccessToken').mockImplementation(
    async function (this: AuthClient) {
      this.setCredentials({
        ...this.credentials,
        access_token: accessToken,
        expiry_date: expiryDate,
      });
      return {token: accessToken};
    },
  );
}

/** The serialized token cache the manager stored, parsed back. */
function readCache(context: Context): Record<string, unknown> {
  const raw = context.state.get<string>(CACHE_KEY);
  if (raw === undefined) {
    expect.fail(`no token cache found under ${CACHE_KEY}`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/** An error shaped like a token-endpoint rejection from gaxios. */
function tokenEndpointError(): Error & {status: number} {
  return Object.assign(new Error('invalid_grant'), {status: 400});
}

function oauthConfig(
  overrides: Partial<{tokenCacheKey: string}> = {},
): BaseGoogleCredentialsConfig {
  return new BaseGoogleCredentialsConfig({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    scopes: SCOPES,
    tokenCacheKey: CACHE_KEY,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BaseGoogleCredentialsConfig validation', () => {
  it('rejects credentials combined with an external access token key', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: makeClient({accessToken: 'token'}),
          externalAccessTokenKey: 'access_token',
        }),
    ).toThrow(
      'If credentials are provided, externalAccessTokenKey, clientId, ' +
        'clientSecret, and scopes must not be provided.',
    );
  });

  it('rejects credentials combined with a client id', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: makeClient({accessToken: 'token'}),
          clientId: 'client-id',
        }),
    ).toThrow('If credentials are provided');
  });

  it('rejects an external access token key combined with a client id', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'access_token',
          clientId: 'client-id',
        }),
    ).toThrow(
      'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
        'scopes must not be provided.',
    );
  });

  it('rejects a client id without a client secret', () => {
    expect(
      () => new BaseGoogleCredentialsConfig({clientId: 'client-id'}),
    ).toThrow(
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  });

  it('accepts each of the three valid combinations', () => {
    const client = makeClient({accessToken: 'token'});
    expect(
      new BaseGoogleCredentialsConfig({credentials: client}).credentials,
    ).toBe(client);
    expect(
      new BaseGoogleCredentialsConfig({externalAccessTokenKey: 'k'})
        .externalAccessTokenKey,
    ).toBe('k');
    expect(oauthConfig().scopes).toEqual(SCOPES);
  });

  it('adopts no identity from a client that carries no OAuth fields', () => {
    // PassThroughClient extends AuthClient directly, so it declares no
    // `_clientId` at all — the shape an `instanceof OAuth2Client` check would
    // conflate with a service account.
    const config = new BaseGoogleCredentialsConfig({
      credentials: new PassThroughClient(),
    });

    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toBeUndefined();
  });

  it('adopts the OAuth identity of an authorized-user client', () => {
    const config = new BaseGoogleCredentialsConfig({
      credentials: makeClient({
        accessToken: 'token',
        refreshToken: 'refresh',
        scope: 'scope-a scope-b',
        clientId: 'copied-id',
        clientSecret: 'copied-secret',
      }),
    });

    expect(config.clientId).toBe('copied-id');
    expect(config.clientSecret).toBe('copied-secret');
    expect(config.scopes).toEqual(['scope-a', 'scope-b']);
  });
});

describe('GoogleCredentialsManager external access token', () => {
  it('builds a client from the token in session state', async () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'access_token',
    });
    const context = makeContext({access_token: 'external-token'});

    const client = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(context);

    expect(client?.credentials.access_token).toBe('external-token');
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('rejects when session state holds no token', async () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'access_token',
    });

    await expect(
      new GoogleCredentialsManager(config).getValidCredentials(makeContext()),
    ).rejects.toThrow(
      'externalAccessTokenKey is provided but no access token found in ' +
        'toolContext.state with key access_token.',
    );
  });
});

describe('GoogleCredentialsManager app-supplied credentials', () => {
  it('returns a valid credential without refreshing it', async () => {
    const client = makeClient({
      accessToken: 'token',
      expiryDate: Date.now() + HOUR_MS,
    });
    const refresh = vi.spyOn(client, 'getAccessToken');
    const config = new BaseGoogleCredentialsConfig({credentials: client});

    const resolved = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(makeContext());

    expect(resolved).toBe(client);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('returns a credential that states no lifetime as it stands', async () => {
    // A service-account or metadata client the application already refreshed
    // reports no expiry. adk-python treats such a credential as valid too.
    const client = makeClient({accessToken: 'token'});
    const refresh = vi.spyOn(client, 'getAccessToken');
    const config = new BaseGoogleCredentialsConfig({credentials: client});

    const resolved = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(makeContext());

    expect(resolved).toBe(client);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired credential that has no refresh token', async () => {
    const client = makeClient({
      accessToken: 'stale',
      expiryDate: Date.now() - HOUR_MS,
    });
    const refresh = vi
      .spyOn(client, 'getAccessToken')
      .mockResolvedValue({token: 'fresh'});
    const config = new BaseGoogleCredentialsConfig({credentials: client});

    const resolved = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(makeContext());

    expect(resolved).toBe(client);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('returns the credential when its refresh fails', async () => {
    const client = makeClient({
      accessToken: 'stale',
      expiryDate: Date.now() - HOUR_MS,
    });
    vi.spyOn(client, 'getAccessToken').mockRejectedValue(
      new Error('metadata server unreachable'),
    );
    const config = new BaseGoogleCredentialsConfig({credentials: client});

    const resolved = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(makeContext());

    expect(resolved).toBe(client);
  });
});

describe('GoogleCredentialsManager token cache', () => {
  it('resolves a cached token that is still valid', async () => {
    const expiry = Date.now() + HOUR_MS;
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'cached-token',
        refresh_token: 'refresh',
        expiry: new Date(expiry).toISOString(),
      }),
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client?.credentials.access_token).toBe('cached-token');
    expect(client?.credentials.expiry_date).toBe(expiry);
    expect(client?.credentials.scope).toBe(SCOPES.join(' '));
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('refreshes an expired cached token and stores the new one', async () => {
    const newExpiry = Date.now() + HOUR_MS;
    stubRefresh('refreshed-token', newExpiry);
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'stale-token',
        refresh_token: 'refresh',
        expiry: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client?.credentials.access_token).toBe('refreshed-token');
    expect(readCache(context)).toEqual({
      token: 'refreshed-token',
      refresh_token: 'refresh',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: 'client-id',
      client_secret: 'client-secret',
      scopes: SCOPES,
      expiry: new Date(newExpiry).toISOString(),
    });
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('takes the scopes from the cache when the config declares none', async () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCacheKey: CACHE_KEY,
    });
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'cached-token',
        refresh_token: 'refresh',
        scopes: ['scope-a', 'scope-b', 42],
        expiry: new Date(Date.now() + HOUR_MS).toISOString(),
      }),
    });

    const client = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(context);

    expect(client?.credentials.scope).toBe('scope-a scope-b');
  });

  it('ignores a cache scopes field that is not an array', async () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCacheKey: CACHE_KEY,
    });
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'cached-token',
        refresh_token: 'refresh',
        scopes: 'scope-a scope-b',
        expiry: new Date(Date.now() + HOUR_MS).toISOString(),
      }),
    });

    const client = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(context);

    expect(client?.credentials.scope).toBeUndefined();
    expect(client?.credentials.access_token).toBe('cached-token');
  });

  it('refreshes a cached token that recorded no expiry', async () => {
    const newExpiry = Date.now() + HOUR_MS;
    stubRefresh('refreshed-token', newExpiry);
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'undated-token',
        refresh_token: 'refresh',
      }),
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client?.credentials.access_token).toBe('refreshed-token');
    expect(readCache(context)).toMatchObject({
      token: 'refreshed-token',
      expiry: new Date(newExpiry).toISOString(),
    });
  });

  it('refreshes a cached token whose expiry cannot be parsed', async () => {
    const newExpiry = Date.now() + HOUR_MS;
    stubRefresh('refreshed-token', newExpiry);
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'cached-token',
        refresh_token: 'refresh',
        expiry: 'the day after tomorrow',
      }),
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client?.credentials.access_token).toBe('refreshed-token');
  });

  it('never writes state when no cache key is configured', async () => {
    vi.spyOn(oauth2ClientPrototype, 'getAccessToken').mockResolvedValue({
      token: 'refreshed-token',
    });
    const context = makeContext({
      'temp:google_credentials': {
        authType: 'oauth2',
        oauth2: {accessToken: 'granted-token', refreshToken: 'refresh'},
      },
    });
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: SCOPES,
    });

    const client = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(context);

    expect(client?.credentials.access_token).toBe('granted-token');
    expect(context.state.hasDelta()).toBe(false);
  });
});

describe('GoogleCredentialsManager refresh failures', () => {
  it('asks for a new authorization when the token endpoint rejects the refresh', async () => {
    vi.spyOn(oauth2ClientPrototype, 'getAccessToken').mockRejectedValue(
      tokenEndpointError(),
    );
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'stale-token',
        refresh_token: 'revoked',
        expiry: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client).toBeUndefined();
    expect(Object.keys(context.eventActions.requestedAuthConfigs)).toEqual([
      'fc-1',
    ]);
  });

  it('propagates a refresh failure the token endpoint did not cause', async () => {
    vi.spyOn(oauth2ClientPrototype, 'getAccessToken').mockRejectedValue(
      new Error('socket hang up'),
    );
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'stale-token',
        refresh_token: 'refresh',
        expiry: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    });

    await expect(
      new GoogleCredentialsManager(oauthConfig()).getValidCredentials(context),
    ).rejects.toThrow('socket hang up');
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('treats an invalid_grant body without a status as a rejection', async () => {
    vi.spyOn(oauth2ClientPrototype, 'getAccessToken').mockRejectedValue(
      new Error('Token has been expired or revoked: invalid_grant'),
    );
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'stale-token',
        refresh_token: 'revoked',
        expiry: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client).toBeUndefined();
  });

  it('reads the status nested under an http response', async () => {
    vi.spyOn(oauth2ClientPrototype, 'getAccessToken').mockRejectedValue(
      Object.assign(new Error('Bad Request'), {response: {status: 401}}),
    );
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        token: 'stale-token',
        refresh_token: 'revoked',
        expiry: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client).toBeUndefined();
  });

  it('requests authorization when a refresh reports success but yields no token', async () => {
    vi.spyOn(oauth2ClientPrototype, 'getAccessToken').mockResolvedValue({
      token: null,
    });
    const context = makeContext({
      [CACHE_KEY]: JSON.stringify({
        refresh_token: 'refresh',
      }),
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client).toBeUndefined();
    expect(Object.keys(context.eventActions.requestedAuthConfigs)).toEqual([
      'fc-1',
    ]);
  });
});

describe('GoogleCredentialsManager OAuth flow', () => {
  it('requests an authorization describing the Google endpoints and scopes', async () => {
    const context = makeContext();

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client).toBeUndefined();
    const requested = context.eventActions.requestedAuthConfigs['fc-1'];
    expect(requested.credentialKey).toBe(CACHE_KEY);
    expect(requested.authScheme).toEqual({
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          scopes: {[SCOPES[0]]: `Access to ${SCOPES[0]}`},
        },
      },
    });
    expect(requested.rawAuthCredential?.oauth2).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
  });

  it('falls back to a default credential key when no cache key is set', async () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    const context = makeContext();

    await new GoogleCredentialsManager(config).getValidCredentials(context);

    expect(
      context.eventActions.requestedAuthConfigs['fc-1'].credentialKey,
    ).toBe('google_credentials');
  });

  it('caches a credential that carries no scopes and no expiry', async () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenCacheKey: CACHE_KEY,
    });
    const context = makeContext({
      [`temp:${CACHE_KEY}`]: {
        authType: 'oauth2',
        oauth2: {accessToken: 'granted-token', refreshToken: 'granted-refresh'},
      },
    });

    await new GoogleCredentialsManager(config).getValidCredentials(context);

    expect(readCache(context)).toEqual({
      token: 'granted-token',
      refresh_token: 'granted-refresh',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
  });

  it('builds and caches a credential once the user has authorized', async () => {
    const context = makeContext({
      [`temp:${CACHE_KEY}`]: {
        authType: 'oauth2',
        oauth2: {accessToken: 'granted-token', refreshToken: 'granted-refresh'},
      },
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client?.credentials.access_token).toBe('granted-token');
    expect(client?.credentials.refresh_token).toBe('granted-refresh');
    expect(readCache(context)).toMatchObject({
      token: 'granted-token',
      refresh_token: 'granted-refresh',
      scopes: SCOPES,
    });
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('keeps the lifetime the authorization granted', async () => {
    const expiresAt = Date.now() + HOUR_MS;
    const context = makeContext({
      [`temp:${CACHE_KEY}`]: {
        authType: 'oauth2',
        oauth2: {
          accessToken: 'granted-token',
          refreshToken: 'granted-refresh',
          expiresAt,
        },
      },
    });

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(context);

    expect(client?.credentials.expiry_date).toBe(expiresAt);
    expect(readCache(context)).toMatchObject({
      expiry: new Date(expiresAt).toISOString(),
    });
  });

  it('refreshes the granted credential once its lifetime runs out', async () => {
    const newExpiry = Date.now() + HOUR_MS;
    const context = makeContext({
      [`temp:${CACHE_KEY}`]: {
        authType: 'oauth2',
        oauth2: {
          accessToken: 'granted-token',
          refreshToken: 'granted-refresh',
          expiresAt: Date.now() - HOUR_MS,
        },
      },
    });
    await new GoogleCredentialsManager(oauthConfig()).getValidCredentials(
      context,
    );

    stubRefresh('refreshed-token', newExpiry);
    const later = makeContext(context.state.toRecord());
    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(later);

    expect(client?.credentials.access_token).toBe('refreshed-token');
    expect(later.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('lets a second manager resolve the cached credential without a new flow', async () => {
    const context = makeContext({
      [`temp:${CACHE_KEY}`]: {
        authType: 'oauth2',
        oauth2: {
          accessToken: 'granted-token',
          refreshToken: 'granted-refresh',
          expiresAt: Date.now() + HOUR_MS,
        },
      },
    });
    await new GoogleCredentialsManager(oauthConfig()).getValidCredentials(
      context,
    );

    // Carry over the persisted cache but not the temp slot holding the grant,
    // so the second manager can resolve the credential from nowhere else.
    const persisted = context.state.toRecord();
    delete persisted[`temp:${CACHE_KEY}`];
    const refresh = vi
      .spyOn(oauth2ClientPrototype, 'getAccessToken')
      .mockRejectedValue(new Error('a valid cached token must not refresh'));
    const second = makeContext(persisted);

    const client = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(second);

    expect(client?.credentials.access_token).toBe('granted-token');
    expect(refresh).not.toHaveBeenCalled();
    expect(second.eventActions.requestedAuthConfigs).toEqual({});
  });
});
