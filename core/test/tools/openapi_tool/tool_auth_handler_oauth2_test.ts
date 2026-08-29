/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  ToolAuthHandler,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';

const TOKEN_URL = 'https://example.com/token';
const STORE_KEY = 'oauth2_existing_exchanged_credential';
const AUTH_RESPONSE_KEY = 'temp:default_openapi_key';

const OAUTH2_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/authorize',
      tokenUrl: TOKEN_URL,
      scopes: {},
    },
  },
};

const CLIENT_CREDENTIALS_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'oauth2',
  flows: {clientCredentials: {tokenUrl: TOKEN_URL, scopes: {}}},
};

/** Builds a context whose session state starts with the given entries. */
function createContext(state: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app', state}),
      pluginManager: new PluginManager([]),
    }),
  });
}

/** An OAuth2 credential holding a token that expires in an hour. */
function freshCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'stored-access-token',
      refreshToken: 'stored-refresh-token',
      expiresAt: Date.now() + 3_600_000,
    },
  };
}

/** An OAuth2 credential whose token expired an hour ago. */
function expiredCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'stale-access-token',
      refreshToken: 'stale-refresh-token',
      expiresAt: Date.now() - 3_600_000,
    },
  };
}

/** Stubs the token endpoint with a successful token response. */
function stubTokenEndpoint(accessToken: string, refreshToken: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
    }),
  });
  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

describe('ToolAuthHandler OAuth2 credentials', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('converts a stored OAuth2 credential into a bearer credential', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const context = createContext({[STORE_KEY]: freshCredential()});

    const result = await new ToolAuthHandler(
      context,
      OAUTH2_SCHEME,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.authType).toBe(AuthCredentialTypes.HTTP);
    expect(result.authCredential?.http?.scheme).toBe('bearer');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'stored-access-token',
    );
    // The token is still valid, so no token request is made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a stored HTTP credential unchanged', async () => {
    const storedCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'service-account-token'}},
    };
    const context = createContext({[STORE_KEY]: storedCredential});

    const result = await new ToolAuthHandler(
      context,
      OAUTH2_SCHEME,
    ).prepareAuthCredentials();

    expect(result.authCredential).toEqual(storedCredential);
  });

  it('refreshes an expired stored credential and replaces the stored copy', async () => {
    const fetchMock = stubTokenEndpoint(
      'refreshed-access-token',
      'rotated-refresh-token',
    );
    const context = createContext({[STORE_KEY]: expiredCredential()});

    const result = await new ToolAuthHandler(
      context,
      OAUTH2_SCHEME,
    ).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe(
      'refreshed-access-token',
    );
    // A provider that rotates the refresh token invalidates the previous one,
    // so the stored credential must carry the rotated one.
    const stored = context.state.get<AuthCredential>(STORE_KEY);
    expect(stored?.oauth2?.accessToken).toBe('refreshed-access-token');
    expect(stored?.oauth2?.refreshToken).toBe('rotated-refresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, expect.anything());
  });

  it('keeps the stale token when the refresh request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const context = createContext({[STORE_KEY]: expiredCredential()});

    const result = await new ToolAuthHandler(
      context,
      OAUTH2_SCHEME,
    ).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe(
      'stale-access-token',
    );
    const stored = context.state.get<AuthCredential>(STORE_KEY);
    expect(stored?.oauth2?.refreshToken).toBe('stale-refresh-token');
  });

  it('stores the OAuth2 credential from an auth response, not the bearer credential', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const context = createContext({[AUTH_RESPONSE_KEY]: freshCredential()});

    const result = await new ToolAuthHandler(
      context,
      OAUTH2_SCHEME,
    ).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe(
      'stored-access-token',
    );
    // The bearer credential carries neither the refresh token nor the expiry,
    // so storing it would strand the session on a token it cannot renew.
    const stored = context.state.get<AuthCredential>(STORE_KEY);
    expect(stored?.oauth2?.refreshToken).toBe('stored-refresh-token');
    expect(stored?.http).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores the exchange result when the credential carries no access token', async () => {
    stubTokenEndpoint('granted-token', 'granted-refresh-token');
    const context = createContext();

    const result = await new ToolAuthHandler(
      context,
      CLIENT_CREDENTIALS_SCHEME,
      {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
      },
    ).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe(
      'granted-token',
    );
    // There is no durable credential to keep, so the exchange result is cached
    // as it was before this change.
    const stored = context.state.get<AuthCredential>(STORE_KEY);
    expect(stored?.http?.credentials.token).toBe('granted-token');
  });
});
