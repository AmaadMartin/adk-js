/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {
  Credentials,
  JWT,
  OAuth2Client,
  UserRefreshClient,
} from 'google-auth-library';
import {describe, expect, it, vi} from 'vitest';

import {
  BaseGoogleCredentialsConfig,
  BaseGoogleCredentialsConfigOptions,
  GoogleCredentialsManager,
  googleCredentialKey,
  isCredentialExpired,
  isCredentialValid,
  isTokenRefreshFailure,
  isUserOAuth2Credentials,
} from '../../src/tools/google_credentials.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const SCOPES = ['https://www.googleapis.com/auth/bigquery'];
const TOKEN_CACHE_KEY = 'test_token_cache';
const FUNCTION_CALL_ID = 'test-function-call-id';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth';
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

/**
 * A config that caches its credential. Only a subclass can name the cache key,
 * as `BigtableCredentialsConfig` does.
 */
class CachingCredentialsConfig extends BaseGoogleCredentialsConfig {
  declare readonly tokenCacheKey: string;

  constructor(
    options: BaseGoogleCredentialsConfigOptions,
    tokenCacheKey: string,
  ) {
    super(options);
    this.tokenCacheKey = tokenCacheKey;
  }
}

/** An OAuth2 config that drives a consent flow and caches its result. */
function createOAuthConfig(
  tokenCacheKey?: string,
): BaseGoogleCredentialsConfig {
  const options = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: SCOPES,
  };
  return tokenCacheKey
    ? new CachingCredentialsConfig(options, tokenCacheKey)
    : new BaseGoogleCredentialsConfig(options);
}

/** A user credential, the kind a consent flow mints. */
function createUserClient(credentials: Credentials): UserRefreshClient {
  const client = new UserRefreshClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: 'user-refresh-token',
  });
  client.setCredentials(credentials);
  return client;
}

/** A service account credential, which no consent flow can replace. */
function createServiceAccountClient(credentials?: Credentials): JWT {
  const client = new JWT({
    email: 'service-account@example.iam.gserviceaccount.com',
    key: 'unused-private-key',
    scopes: SCOPES,
  });
  if (credentials) {
    client.setCredentials(credentials);
  }
  return client;
}

/** Makes `refreshAccessToken` mint a new access token, as the endpoint would. */
function mockRefreshSuccess(
  client: OAuth2Client,
  accessToken: string,
  expiryDate: number = Date.now() + HOUR_MS,
) {
  return vi.spyOn(client, 'refreshAccessToken').mockImplementation(async () => {
    client.setCredentials({
      access_token: accessToken,
      refresh_token: client.credentials.refresh_token,
      expiry_date: expiryDate,
    });
    return {credentials: client.credentials, res: null};
  });
}

/** The rejection shape gaxios raises when the token endpoint refuses. */
function createTokenEndpointError(): Error {
  const error = new Error('invalid_grant');
  error.name = 'GaxiosError';
  return error;
}

/** A cache entry in the shape adk-python's `Credentials.to_json()` writes. */
function createCacheEntry(token: string, expiry: Date): string {
  return JSON.stringify({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: 'cached-refresh-token',
    token,
    token_uri: TOKEN_URL,
    scopes: SCOPES,
    expiry: expiry.toISOString(),
  });
}

function readCacheEntry(context: Context): Record<string, unknown> {
  const raw = context.state.get<string>(TOKEN_CACHE_KEY);
  expect(typeof raw).toBe('string');
  return JSON.parse(raw ?? '{}');
}

describe('BaseGoogleCredentialsConfig', () => {
  it('rejects credentials combined with an external access token key', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: createServiceAccountClient(),
          externalAccessTokenKey: 'user_access_token',
        }),
    ).toThrowError(
      'If credentials are provided, externalAccessTokenKey, clientId, ' +
        'clientSecret, and scopes must not be provided.',
    );
  });

  it('rejects credentials combined with an OAuth2 client', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: createServiceAccountClient(),
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }),
    ).toThrowError('If credentials are provided');
  });

  it('rejects credentials combined with scopes alone', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: createServiceAccountClient(),
          scopes: SCOPES,
        }),
    ).toThrowError('If credentials are provided');
  });

  it('rejects an external access token key combined with a client id', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'user_access_token',
          clientId: CLIENT_ID,
        }),
    ).toThrowError(
      'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
        'scopes must not be provided.',
    );
  });

  it('rejects an external access token key combined with scopes', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'user_access_token',
          scopes: SCOPES,
        }),
    ).toThrowError('If externalAccessTokenKey is provided');
  });

  it('rejects a client id with no client secret', () => {
    expect(
      () => new BaseGoogleCredentialsConfig({clientId: CLIENT_ID}),
    ).toThrowError(
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  });

  it('rejects a configuration naming no credential mode', () => {
    expect(() => new BaseGoogleCredentialsConfig({})).toThrowError(
      'Must provide one of credentials',
    );
  });

  it('accepts each of the three single-mode configurations', () => {
    const credentials = createServiceAccountClient();
    expect(new BaseGoogleCredentialsConfig({credentials}).credentials).toBe(
      credentials,
    );
    expect(
      new BaseGoogleCredentialsConfig({
        externalAccessTokenKey: 'user_access_token',
      }).externalAccessTokenKey,
    ).toBe('user_access_token');
    expect(createOAuthConfig().clientId).toBe(CLIENT_ID);
  });

  it('back-fills the OAuth2 client from user credentials', () => {
    const config = new BaseGoogleCredentialsConfig({
      credentials: createUserClient({
        access_token: 'access-token',
        scope: SCOPES.join(' '),
      }),
    });

    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual(SCOPES);
  });

  it('does not back-fill an OAuth2 client from service account credentials', () => {
    const config = new BaseGoogleCredentialsConfig({
      credentials: createServiceAccountClient({access_token: 'access-token'}),
    });

    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toBeUndefined();
  });
});

describe('isCredentialValid / isCredentialExpired', () => {
  it('treats a credential with no access token as invalid', () => {
    const client = createUserClient({refresh_token: 'user-refresh-token'});
    expect(isCredentialValid(client)).toBe(false);
    expect(isCredentialExpired(client)).toBe(false);
  });

  it('treats an access token with no expiry as valid', () => {
    const client = createUserClient({access_token: 'access-token'});
    expect(isCredentialValid(client)).toBe(true);
    expect(isCredentialExpired(client)).toBe(false);
  });

  it('treats an access token expiring in the future as valid', () => {
    const client = createUserClient({
      access_token: 'access-token',
      expiry_date: Date.now() + HOUR_MS,
    });
    expect(isCredentialValid(client)).toBe(true);
    expect(isCredentialExpired(client)).toBe(false);
  });

  it('treats an access token with a past expiry as expired', () => {
    const client = createUserClient({
      access_token: 'access-token',
      expiry_date: Date.now() - HOUR_MS,
    });
    expect(isCredentialValid(client)).toBe(false);
    expect(isCredentialExpired(client)).toBe(true);
  });
});

describe('isUserOAuth2Credentials', () => {
  it('accepts a user refresh client', () => {
    expect(isUserOAuth2Credentials(createUserClient({}))).toBe(true);
  });

  it('rejects a service account client', () => {
    expect(isUserOAuth2Credentials(createServiceAccountClient())).toBe(false);
  });

  it('rejects a service account client carrying a placeholder refresh token', () => {
    const client = createServiceAccountClient();
    expect(client.credentials.refresh_token).toBe('jwt-placeholder');
    expect(isUserOAuth2Credentials(client)).toBe(false);
  });

  it('rejects a bare OAuth2 client holding only an access token', () => {
    const client = new OAuth2Client();
    client.setCredentials({access_token: 'access-token'});
    expect(isUserOAuth2Credentials(client)).toBe(false);
  });
});

describe('isTokenRefreshFailure', () => {
  it('accepts a rejection from the token endpoint', () => {
    expect(isTokenRefreshFailure(createTokenEndpointError())).toBe(true);
  });

  it('accepts an error carrying an HTTP status', () => {
    const error = Object.assign(new Error('unauthorized'), {status: 401});
    expect(isTokenRefreshFailure(error)).toBe(true);
  });

  it('rejects a programming fault', () => {
    expect(isTokenRefreshFailure(new TypeError('bad argument'))).toBe(false);
  });

  it('rejects an error whose status is not a number', () => {
    const error = Object.assign(new Error('odd'), {status: 'teapot'});
    expect(isTokenRefreshFailure(error)).toBe(false);
  });

  it('rejects a value that is not an error', () => {
    expect(isTokenRefreshFailure('invalid_grant')).toBe(false);
  });
});

describe('googleCredentialKey', () => {
  it('is stable regardless of scope order', () => {
    const scopes = ['https://example.com/b', 'https://example.com/a'];
    expect(googleCredentialKey(CLIENT_ID, scopes)).toBe(
      googleCredentialKey(CLIENT_ID, [...scopes].reverse()),
    );
  });

  it('differs for a different client id', () => {
    expect(googleCredentialKey(CLIENT_ID, SCOPES)).not.toBe(
      googleCredentialKey('other-client-id', SCOPES),
    );
  });

  it('differs for a different scope set', () => {
    expect(googleCredentialKey(CLIENT_ID, SCOPES)).not.toBe(
      googleCredentialKey(CLIENT_ID, [...SCOPES, 'https://example.com/extra']),
    );
  });

  it('is a bounded, prefixed state key', () => {
    expect(googleCredentialKey(CLIENT_ID, SCOPES)).toMatch(
      /^google_credentials_[0-9a-f]{16}$/,
    );
  });
});

describe('GoogleCredentialsManager', () => {
  it('returns valid user credentials without starting a flow', async () => {
    const credentials = createUserClient({
      access_token: 'access-token',
      expiry_date: Date.now() + HOUR_MS,
    });
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials}),
    );
    const context = createToolContext();
    const getAuthResponse = vi.spyOn(context, 'getAuthResponse');
    const requestCredential = vi.spyOn(context, 'requestCredential');

    expect(await manager.getValidCredentials(context)).toBe(credentials);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('returns valid service account credentials without refreshing them', async () => {
    const credentials = createServiceAccountClient({
      access_token: 'access-token',
      expiry_date: Date.now() + HOUR_MS,
    });
    const getAccessToken = vi.spyOn(credentials, 'getAccessToken');
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials}),
    );
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    expect(await manager.getValidCredentials(context)).toBe(credentials);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('refreshes invalid service account credentials', async () => {
    const credentials = createServiceAccountClient();
    const getAccessToken = vi
      .spyOn(credentials, 'getAccessToken')
      .mockImplementation(async () => ({token: 'refreshed-access-token'}));
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials}),
    );
    const context = createToolContext();

    expect(await manager.getValidCredentials(context)).toBe(credentials);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('returns service account credentials whose refresh failed', async () => {
    const credentials = createServiceAccountClient();
    vi.spyOn(credentials, 'getAccessToken').mockRejectedValue(
      new Error('metadata server unreachable'),
    );
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials}),
    );
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    expect(await manager.getValidCredentials(context)).toBe(credentials);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('rebuilds valid credentials from the session cache', async () => {
    const expiry = new Date(Date.now() + HOUR_MS);
    const config = createOAuthConfig(TOKEN_CACHE_KEY);
    const manager = new GoogleCredentialsManager(config);
    const context = createToolContext({
      [TOKEN_CACHE_KEY]: createCacheEntry('cached-access-token', expiry),
    });
    const requestCredential = vi.spyOn(context, 'requestCredential');

    const credentials = await manager.getValidCredentials(context);

    expect(credentials?.credentials.access_token).toBe('cached-access-token');
    expect(credentials?.credentials.refresh_token).toBe('cached-refresh-token');
    expect(credentials?.credentials.expiry_date).toBe(expiry.getTime());
    expect(credentials?.credentials.scope).toBe(SCOPES.join(' '));
    expect(config.credentials).toBeUndefined();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('rebuilds credentials from a cache entry that carries no expiry', async () => {
    const manager = new GoogleCredentialsManager(
      createOAuthConfig(TOKEN_CACHE_KEY),
    );
    const context = createToolContext({
      [TOKEN_CACHE_KEY]: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: 'cached-refresh-token',
        token: 'cached-access-token',
      }),
    });

    const credentials = await manager.getValidCredentials(context);

    expect(credentials?.credentials.access_token).toBe('cached-access-token');
    expect(credentials?.credentials.expiry_date).toBeUndefined();
  });

  it('propagates a malformed cache entry', async () => {
    const manager = new GoogleCredentialsManager(
      createOAuthConfig(TOKEN_CACHE_KEY),
    );
    const context = createToolContext({
      [TOKEN_CACHE_KEY]: JSON.stringify({client_id: CLIENT_ID}),
    });

    await expect(manager.getValidCredentials(context)).rejects.toThrowError(
      'does not contain a client_secret field',
    );
  });

  it('requests consent when nothing is configured and nothing is cached', async () => {
    const manager = new GoogleCredentialsManager(
      createOAuthConfig(TOKEN_CACHE_KEY),
    );
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    expect(await manager.getValidCredentials(context)).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('requests consent with the Google authorization-code scheme', async () => {
    const manager = new GoogleCredentialsManager(createOAuthConfig());
    const context = createToolContext();

    await manager.getValidCredentials(context);

    const requested =
      context.eventActions.requestedAuthConfigs[FUNCTION_CALL_ID];
    expect(requested?.credentialKey).toBe(
      googleCredentialKey(CLIENT_ID, SCOPES),
    );
    expect(requested?.rawAuthCredential).toEqual({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: CLIENT_ID, clientSecret: CLIENT_SECRET},
    });
    expect(requested?.authScheme).toMatchObject({
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: AUTHORIZATION_URL,
          tokenUrl: TOKEN_URL,
          scopes: {[SCOPES[0]]: `Access to ${SCOPES[0]}`},
        },
      },
    });
  });

  it('refreshes expired cached credentials and rewrites the cache', async () => {
    const config = createOAuthConfig(TOKEN_CACHE_KEY);
    const manager = new GoogleCredentialsManager(config);
    const context = createToolContext({
      [TOKEN_CACHE_KEY]: createCacheEntry(
        'stale-access-token',
        new Date(Date.now() - HOUR_MS),
      ),
    });
    const refresh = vi
      .spyOn(UserRefreshClient.prototype, 'refreshAccessToken')
      .mockImplementation(async function (this: UserRefreshClient) {
        this.setCredentials({
          access_token: 'refreshed-access-token',
          refresh_token: 'cached-refresh-token',
          expiry_date: Date.now() + HOUR_MS,
        });
        return {credentials: this.credentials, res: null};
      });

    const credentials = await manager.getValidCredentials(context);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(credentials?.credentials.access_token).toBe(
      'refreshed-access-token',
    );
    expect(readCacheEntry(context)).toMatchObject({
      type: 'authorized_user',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: 'cached-refresh-token',
      token: 'refreshed-access-token',
      token_uri: TOKEN_URL,
      scopes: SCOPES,
    });
    expect(config.credentials).toBeUndefined();
    refresh.mockRestore();
  });

  it('refreshes expired configured credentials', async () => {
    const credentials = createUserClient({
      access_token: 'stale-access-token',
      refresh_token: 'user-refresh-token',
      expiry_date: Date.now() - HOUR_MS,
    });
    mockRefreshSuccess(credentials, 'refreshed-access-token');
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials}),
    );
    const context = createToolContext();

    const result = await manager.getValidCredentials(context);

    expect(result).toBe(credentials);
    expect(result?.credentials.access_token).toBe('refreshed-access-token');
  });

  it('requests consent when the token endpoint refuses the refresh', async () => {
    const credentials = createUserClient({
      access_token: 'stale-access-token',
      refresh_token: 'user-refresh-token',
      expiry_date: Date.now() - HOUR_MS,
    });
    vi.spyOn(credentials, 'refreshAccessToken').mockRejectedValue(
      createTokenEndpointError(),
    );
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials}),
    );
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    expect(await manager.getValidCredentials(context)).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('propagates an unexpected refresh error to the caller', async () => {
    const credentials = createUserClient({
      access_token: 'stale-access-token',
      refresh_token: 'user-refresh-token',
      expiry_date: Date.now() - HOUR_MS,
    });
    vi.spyOn(credentials, 'refreshAccessToken').mockRejectedValue(
      new TypeError('credentials.refreshAccessToken is not a function'),
    );
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials}),
    );
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    await expect(manager.getValidCredentials(context)).rejects.toThrowError(
      TypeError,
    );
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('requests consent when a refresh leaves the credentials invalid', async () => {
    const credentials = createUserClient({
      access_token: 'stale-access-token',
      refresh_token: 'user-refresh-token',
      expiry_date: Date.now() - HOUR_MS,
    });
    vi.spyOn(credentials, 'refreshAccessToken').mockImplementation(async () => {
      credentials.setCredentials({refresh_token: 'user-refresh-token'});
      return {credentials: credentials.credentials, res: null};
    });
    const config = new BaseGoogleCredentialsConfig({credentials});
    const manager = new GoogleCredentialsManager(config);
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    expect(await manager.getValidCredentials(context)).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
    expect(context.state.get(TOKEN_CACHE_KEY)).toBeUndefined();
  });

  it('requests consent for expired credentials that carry no refresh token', async () => {
    const credentials = createUserClient({
      access_token: 'stale-access-token',
      expiry_date: Date.now() - HOUR_MS,
    });
    const refresh = vi.spyOn(credentials, 'refreshAccessToken');
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({credentials}),
    );
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    expect(await manager.getValidCredentials(context)).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('builds and caches credentials from a completed consent flow', async () => {
    const config = createOAuthConfig(TOKEN_CACHE_KEY);
    const manager = new GoogleCredentialsManager(config);
    const authResponse: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        accessToken: 'granted-access-token',
        refreshToken: 'granted-refresh-token',
      },
    };
    const context = createToolContext({
      [`temp:${googleCredentialKey(CLIENT_ID, SCOPES)}`]: authResponse,
    });
    const requestCredential = vi.spyOn(context, 'requestCredential');

    const credentials = await manager.getValidCredentials(context);

    expect(credentials?.credentials.access_token).toBe('granted-access-token');
    expect(credentials?.credentials.refresh_token).toBe(
      'granted-refresh-token',
    );
    expect(readCacheEntry(context)).toMatchObject({
      type: 'authorized_user',
      token: 'granted-access-token',
      refresh_token: 'granted-refresh-token',
      scopes: SCOPES,
    });
    expect(config.credentials).toBeUndefined();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('caches a consent response that carries no refresh token', async () => {
    const manager = new GoogleCredentialsManager(
      createOAuthConfig(TOKEN_CACHE_KEY),
    );
    const authResponse: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'granted-access-token'},
    };
    const context = createToolContext({
      [`temp:${googleCredentialKey(CLIENT_ID, SCOPES)}`]: authResponse,
    });

    await manager.getValidCredentials(context);

    const cached = readCacheEntry(context);
    expect(cached['token']).toBe('granted-access-token');
    expect(cached).not.toHaveProperty('refresh_token');
    expect(cached).not.toHaveProperty('expiry');
  });

  it('caches a consent response that carries no access token', async () => {
    const manager = new GoogleCredentialsManager(
      createOAuthConfig(TOKEN_CACHE_KEY),
    );
    const authResponse: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {refreshToken: 'granted-refresh-token'},
    };
    const context = createToolContext({
      [`temp:${googleCredentialKey(CLIENT_ID, SCOPES)}`]: authResponse,
    });

    await manager.getValidCredentials(context);

    const cached = readCacheEntry(context);
    expect(cached['refresh_token']).toBe('granted-refresh-token');
    expect(cached).not.toHaveProperty('token');
  });

  it('returns consent flow credentials without caching when no cache key is set', async () => {
    const manager = new GoogleCredentialsManager(createOAuthConfig());
    const authResponse: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        accessToken: 'granted-access-token',
        refreshToken: 'granted-refresh-token',
      },
    };
    const context = createToolContext({
      [`temp:${googleCredentialKey(CLIENT_ID, SCOPES)}`]: authResponse,
    });

    const credentials = await manager.getValidCredentials(context);

    expect(credentials?.credentials.access_token).toBe('granted-access-token');
    expect(context.eventActions.stateDelta).toEqual({});
  });

  it('requests consent when the response carries no OAuth2 credential', async () => {
    const manager = new GoogleCredentialsManager(createOAuthConfig());
    const context = createToolContext({
      [`temp:${googleCredentialKey(CLIENT_ID, SCOPES)}`]: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'not-an-oauth2-response',
      },
    });
    const requestCredential = vi.spyOn(context, 'requestCredential');

    expect(await manager.getValidCredentials(context)).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached credential across manager instances', async () => {
    const expiry = new Date(Date.now() + HOUR_MS);
    const state = {
      [TOKEN_CACHE_KEY]: createCacheEntry('cached-access-token', expiry),
    };
    const first = await new GoogleCredentialsManager(
      createOAuthConfig(TOKEN_CACHE_KEY),
    ).getValidCredentials(createToolContext(state));

    const context = createToolContext(state);
    const requestCredential = vi.spyOn(context, 'requestCredential');
    const second = await new GoogleCredentialsManager(
      createOAuthConfig(TOKEN_CACHE_KEY),
    ).getValidCredentials(context);

    expect(first?.credentials.access_token).toBe('cached-access-token');
    expect(second?.credentials.access_token).toBe('cached-access-token');
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('uses the external access token from session state', async () => {
    const manager = new GoogleCredentialsManager(
      new CachingCredentialsConfig(
        {externalAccessTokenKey: 'user_access_token'},
        TOKEN_CACHE_KEY,
      ),
    );
    const context = createToolContext({
      user_access_token: 'external-access-token',
      [TOKEN_CACHE_KEY]: createCacheEntry(
        'cached-access-token',
        new Date(Date.now() + HOUR_MS),
      ),
    });
    const requestCredential = vi.spyOn(context, 'requestCredential');

    const credentials = await manager.getValidCredentials(context);

    expect(credentials?.credentials.access_token).toBe('external-access-token');
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('rejects when the external access token is missing from session state', async () => {
    const manager = new GoogleCredentialsManager(
      new BaseGoogleCredentialsConfig({
        externalAccessTokenKey: 'user_access_token',
      }),
    );

    await expect(
      manager.getValidCredentials(createToolContext()),
    ).rejects.toThrowError(
      'externalAccessTokenKey is provided but no access token found in ' +
        'toolContext.state with key user_access_token.',
    );
  });
});
