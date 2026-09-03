/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  BaseGoogleCredentialsConfig,
  Context,
  GoogleCredentialsManager,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {Credentials, JWT, OAuth2Client} from 'google-auth-library';
import {MockInstance, beforeEach, describe, expect, it, vi} from 'vitest';

const CLIENT_ID = 'test_client_id';
const CLIENT_SECRET = 'test_client_secret';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_CACHE_KEY = 'test_token_cache';
const HOUR_MS = 60 * 60 * 1000;

/**
 * Single-signature views of two overloaded google-auth-library methods.
 * `vi.spyOn` types a spy from the last overload — the callback form — so a
 * spy taken through these views is typed against the promise form the code
 * under test actually calls.
 */
interface AccessTokenGetter {
  getAccessToken: () => Promise<{token?: string | null}>;
}
interface TokenRefresher {
  refreshAccessToken: () => Promise<{credentials: Credentials; res: unknown}>;
}

function spyOnGetAccessToken(client: AccessTokenGetter) {
  return vi.spyOn(client, 'getAccessToken');
}

function spyOnRefreshAccessToken(client: TokenRefresher) {
  return vi.spyOn(client, 'refreshAccessToken');
}

function makeContext(): Context {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({
    invocationContext,
    functionCallId: 'fc-1',
  });
}

function oauthConfig(
  overrides: Partial<{tokenCacheKey: string}> = {},
): BaseGoogleCredentialsConfig {
  return new BaseGoogleCredentialsConfig({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: SCOPES,
    tokenCacheKey: TOKEN_CACHE_KEY,
    ...overrides,
  });
}

/** An OAuth2 user client whose access token is still good. */
function validUserClient(): OAuth2Client {
  const client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  client.setCredentials({
    access_token: 'valid_token',
    refresh_token: 'valid_refresh_token',
    expiry_date: Date.now() + HOUR_MS,
  });
  return client;
}

/** An OAuth2 user client whose access token expired an hour ago. */
function expiredUserClient(): OAuth2Client {
  const client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  client.setCredentials({
    access_token: 'expired_token',
    refresh_token: 'valid_refresh_token',
    expiry_date: Date.now() - HOUR_MS,
  });
  return client;
}

/** A service account client, which never carries an OAuth client id. */
function serviceAccountClient(): JWT {
  return new JWT({
    email: 'agent@example.iam.gserviceaccount.com',
    key: 'unused-in-this-test',
    scopes: SCOPES,
  });
}

/** The token-endpoint rejection google-auth-library surfaces on a dead grant. */
function invalidGrantError(): Error {
  return Object.assign(new Error('invalid_grant'), {
    response: {status: 400},
    error: 'invalid_grant',
  });
}

describe('BaseGoogleCredentialsConfig', () => {
  it('rejects credentials combined with an external access token key', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: validUserClient(),
          externalAccessTokenKey: 'some_key',
        }),
    ).toThrow(
      'If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.',
    );
  });

  it('rejects credentials combined with a client id', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: validUserClient(),
          clientId: CLIENT_ID,
        }),
    ).toThrow('If credentials are provided');
  });

  it('rejects an external access token key combined with a client id', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'some_key',
          clientId: CLIENT_ID,
        }),
    ).toThrow(
      'If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.',
    );
  });

  it('rejects a client id without a client secret', () => {
    expect(
      () => new BaseGoogleCredentialsConfig({clientId: CLIENT_ID}),
    ).toThrow(
      'Must provide one of credentials, externalAccessTokenKey, or clientId and clientSecret pair.',
    );
  });

  it('accepts each single credential source', () => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({credentials: serviceAccountClient()}),
    ).not.toThrow();
    expect(
      () => new BaseGoogleCredentialsConfig({externalAccessTokenKey: 'k'}),
    ).not.toThrow();
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }),
    ).not.toThrow();
  });

  it('derives the client id, secret and scopes from an OAuth2 client', () => {
    const client = new OAuth2Client({
      clientId: 'derived_id',
      clientSecret: 'derived_secret',
    });
    client.setCredentials({access_token: 't', scope: 'scope_a scope_b'});

    const config = new BaseGoogleCredentialsConfig({credentials: client});

    expect(config.clientId).toBe('derived_id');
    expect(config.clientSecret).toBe('derived_secret');
    expect(config.scopes).toEqual(['scope_a', 'scope_b']);
  });

  it('leaves the derived fields unset for a non-OAuth2 client', () => {
    const config = new BaseGoogleCredentialsConfig({
      credentials: serviceAccountClient(),
    });

    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toBeUndefined();
  });

  it('gives configs with different scopes different credential keys', () => {
    const calendar = new BaseGoogleCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: ['calendar'],
    });
    const drive = new BaseGoogleCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: ['drive'],
    });

    expect(calendar.credentialKey).not.toBe(drive.credentialKey);
  });

  it('orders the scopes in the credential key so order does not matter', () => {
    const forward = new BaseGoogleCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: ['a', 'b'],
    });
    const reversed = new BaseGoogleCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: ['b', 'a'],
    });

    expect(forward.credentialKey).toBe(reversed.credentialKey);
  });

  it('prefers an explicit credential key', () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      credentialKey: 'shared_slot',
    });

    expect(config.credentialKey).toBe('shared_slot');
  });

  it('names a default credential key for a config with no client id', () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'k',
    });

    expect(config.credentialKey).toBe('google_tool_default_');
  });
});

describe('GoogleCredentialsManager', () => {
  let toolContext: Context;
  let requestCredential: MockInstance<Context['requestCredential']>;
  let getAuthResponse: MockInstance<Context['getAuthResponse']>;

  beforeEach(() => {
    toolContext = makeContext();
    requestCredential = vi.spyOn(toolContext, 'requestCredential');
    getAuthResponse = vi.spyOn(toolContext, 'getAuthResponse');
  });

  it('returns a valid OAuth2 client without touching the auth flow', async () => {
    const client = validUserClient();
    const config = oauthConfig();
    config.credentials = client;
    const manager = new GoogleCredentialsManager(config);

    const result = await manager.getValidCredentials(toolContext);

    expect(result).toBe(client);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('returns a valid non-OAuth client without refreshing it', async () => {
    const client = serviceAccountClient();
    client.setCredentials({
      access_token: 'sa_token',
      expiry_date: Date.now() + HOUR_MS,
    });
    const getAccessToken = spyOnGetAccessToken(client);
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBe(client);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('refreshes an invalid non-OAuth client and returns it', async () => {
    const client = serviceAccountClient();
    const getAccessToken = spyOnGetAccessToken(client).mockResolvedValue({
      token: 'sa_token',
    });
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBe(client);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('returns a non-OAuth client whose refresh failed', async () => {
    const client = serviceAccountClient();
    const getAccessToken = spyOnGetAccessToken(client).mockRejectedValue(
      new Error('metadata server unreachable'),
    );
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBe(client);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('rebuilds a cached token and leaves the config credential unset', async () => {
    const config = oauthConfig();
    const manager = new GoogleCredentialsManager(config);
    toolContext.state.set(
      TOKEN_CACHE_KEY,
      JSON.stringify({
        type: 'authorized_user',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        access_token: 'cached_token',
        refresh_token: 'cached_refresh_token',
        expiry_date: Date.now() + HOUR_MS,
        scopes: SCOPES,
      }),
    );

    const result = await manager.getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toBe('cached_token');
    expect(config.credentials).toBeUndefined();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('ignores an unreadable cache entry and starts the OAuth flow', async () => {
    const config = oauthConfig();
    toolContext.state.set(TOKEN_CACHE_KEY, 'not json at all');

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('ignores a cache entry that is not an object', async () => {
    const config = oauthConfig();
    toolContext.state.set(TOKEN_CACHE_KEY, '"just a string"');

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('requests a Google OAuth2 flow when nothing is available', async () => {
    const result = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);

    const authConfig = requestCredential.mock.calls[0][0];
    expect(authConfig.credentialKey).toBe(oauthConfig().credentialKey);
    const scheme = authConfig.authScheme;
    if (scheme.type !== 'oauth2') {
      expect.fail(`expected an oauth2 auth scheme, got ${scheme.type}`);
    }
    const flow = scheme.flows.authorizationCode;
    if (!flow) {
      expect.fail('expected an authorization-code flow');
    }
    expect(flow.authorizationUrl).toBe(
      'https://accounts.google.com/o/oauth2/auth',
    );
    expect(flow.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(Object.keys(flow.scopes)).toEqual(SCOPES);
    expect(authConfig.rawAuthCredential?.oauth2?.clientId).toBe(CLIENT_ID);
    expect(authConfig.rawAuthCredential?.oauth2?.clientSecret).toBe(
      CLIENT_SECRET,
    );
  });

  it('refreshes an expired token and writes it to the cache', async () => {
    const client = expiredUserClient();
    const refreshAccessToken = spyOnRefreshAccessToken(
      client,
    ).mockImplementation(async () => {
      client.setCredentials({
        access_token: 'new_token',
        refresh_token: 'valid_refresh_token',
        expiry_date: Date.now() + HOUR_MS,
      });
      return {credentials: client.credentials, res: null};
    });
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBe(client);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    const cached: unknown = JSON.parse(
      toolContext.state.get<string>(TOKEN_CACHE_KEY) ?? '{}',
    );
    expect(cached).toMatchObject({
      type: 'authorized_user',
      access_token: 'new_token',
      client_id: CLIENT_ID,
      scopes: SCOPES,
    });
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('does not cache a refresh that produced no usable token', async () => {
    const client = expiredUserClient();
    spyOnRefreshAccessToken(client).mockResolvedValue({
      credentials: client.credentials,
      res: null,
    });
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(toolContext.state.get(TOKEN_CACHE_KEY)).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('starts a new OAuth flow when the token endpoint rejects the grant', async () => {
    const client = expiredUserClient();
    spyOnRefreshAccessToken(client).mockRejectedValue(invalidGrantError());
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('treats an invalid_grant body with no status as a rejected grant', async () => {
    const client = expiredUserClient();
    spyOnRefreshAccessToken(client).mockRejectedValue({
      error_description: 'Token has been expired or revoked: invalid_grant',
    });
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('propagates a refresh failure that is not a rejected grant', async () => {
    const client = expiredUserClient();
    spyOnRefreshAccessToken(client).mockRejectedValue(
      new TypeError('token endpoint unreachable'),
    );
    const config = oauthConfig();
    config.credentials = client;

    await expect(
      new GoogleCredentialsManager(config).getValidCredentials(toolContext),
    ).rejects.toThrow('token endpoint unreachable');
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('propagates a refresh failure thrown as a non-object', async () => {
    const client = expiredUserClient();
    spyOnRefreshAccessToken(client).mockRejectedValue(
      'token endpoint exploded',
    );
    const config = oauthConfig();
    config.credentials = client;

    await expect(
      new GoogleCredentialsManager(config).getValidCredentials(toolContext),
    ).rejects.toBe('token endpoint exploded');
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('builds and caches a client once the OAuth flow completes', async () => {
    const expiresAt = Date.now() + HOUR_MS;
    getAuthResponse.mockReturnValue({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token',
        expiresAt,
      },
    });

    const result = await new GoogleCredentialsManager(
      oauthConfig(),
    ).getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toBe('new_access_token');
    expect(result?.credentials.refresh_token).toBe('new_refresh_token');
    expect(requestCredential).not.toHaveBeenCalled();
    const cached: unknown = JSON.parse(
      toolContext.state.get<string>(TOKEN_CACHE_KEY) ?? '{}',
    );
    expect(cached).toMatchObject({
      access_token: 'new_access_token',
      refresh_token: 'new_refresh_token',
      expiry_date: expiresAt,
    });
  });

  it('does not write a cache entry when no cache key is configured', async () => {
    getAuthResponse.mockReturnValue({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'new_access_token'},
    });
    const config = new BaseGoogleCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: SCOPES,
    });

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toBe('new_access_token');
    expect(toolContext.state.get(TOKEN_CACHE_KEY)).toBeUndefined();
  });

  it('lets a second manager resolve from the cache the first wrote', async () => {
    const config = oauthConfig();
    getAuthResponse.mockReturnValue({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        accessToken: 'shared_access_token',
        refreshToken: 'shared_refresh_token',
        expiresAt: Date.now() + HOUR_MS,
      },
    });
    await new GoogleCredentialsManager(config).getValidCredentials(toolContext);

    getAuthResponse.mockReturnValue(undefined);
    const second = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(second?.credentials.access_token).toBe('shared_access_token');
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('reads an access token another system placed in session state', async () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'my_access_token',
    });
    toolContext.state.set('my_access_token', 'external_token');

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toBe('external_token');
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('rejects when the external access token is missing from state', async () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'my_access_token',
    });

    await expect(
      new GoogleCredentialsManager(config).getValidCredentials(toolContext),
    ).rejects.toThrow(
      'externalAccessTokenKey is provided but no access token found in toolContext.state with key my_access_token.',
    );
  });

  it('starts the OAuth flow for an expired token with no refresh token', async () => {
    const client = new OAuth2Client({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    client.setCredentials({
      access_token: 'expired_token',
      expiry_date: Date.now() - HOUR_MS,
    });
    const refreshAccessToken = spyOnRefreshAccessToken(client);
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('treats a token with no expiry as valid', async () => {
    const client = new OAuth2Client({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    client.setCredentials({access_token: 'eternal_token', expiry_date: null});
    const config = oauthConfig();
    config.credentials = client;

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBe(client);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('requests an OAuth flow with no scopes when none are configured', async () => {
    const config = new BaseGoogleCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    await new GoogleCredentialsManager(config).getValidCredentials(toolContext);

    const scheme = requestCredential.mock.calls[0][0].authScheme;
    if (scheme.type !== 'oauth2') {
      expect.fail(`expected an oauth2 auth scheme, got ${scheme.type}`);
    }
    expect(scheme.flows.authorizationCode?.scopes).toEqual({});
  });

  it('falls back to the configured client id for a cache entry without one', async () => {
    const config = oauthConfig();
    toolContext.state.set(
      TOKEN_CACHE_KEY,
      JSON.stringify({
        type: 'authorized_user',
        access_token: 'cached_token',
        expiry_date: Date.now() + HOUR_MS,
      }),
    );

    const result = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toBe('cached_token');
    expect(requestCredential).not.toHaveBeenCalled();
  });
});
