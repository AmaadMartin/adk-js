/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  BaseGoogleCredentialsConfig,
  Context,
  GoogleCredentialsManager,
  State,
} from '@google/adk';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_CACHE_KEY = 'test_token_cache';
const HOUR_MS = 60 * 60 * 1000;

/**
 * A credential that is not an OAuth2 client, standing in for a service
 * account, application default credentials or a Compute Engine credential.
 */
class NonOAuth2Client extends AuthClient {
  readonly getAccessToken = vi.fn(async () => ({token: 'minted-token'}));

  async getRequestHeaders(): Promise<Headers> {
    return new Headers();
  }

  request(): never {
    return expect.fail(
      'AuthClient.request must not be called by GoogleCredentialsManager',
    );
  }
}

function createToolContext(state: State = new State()) {
  const getAuthResponse =
    vi.fn<(authConfig: AuthConfig) => AuthCredential | undefined>();
  const requestCredential = vi.fn<(authConfig: AuthConfig) => void>();
  const context = {
    state,
    getAuthResponse,
    requestCredential,
  } as unknown as Context;

  return {context, state, getAuthResponse, requestCredential};
}

function oauthConfig(
  overrides: Partial<{tokenCacheKey: string; scopes: string[]}> = {},
): BaseGoogleCredentialsConfig {
  return new BaseGoogleCredentialsConfig({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: SCOPES,
    ...overrides,
  });
}

function oauthResponse(oauth2: AuthCredential['oauth2']): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

/** Replaces the token endpoint call with an in-memory token mint. */
function stubTokenRefresh(nextToken: string, expiresInMs = HOUR_MS) {
  return vi
    .spyOn(OAuth2Client.prototype, 'getAccessToken')
    .mockImplementation(async function (this: OAuth2Client) {
      this.setCredentials({
        ...this.credentials,
        access_token: nextToken,
        expiry_date: Date.now() + expiresInMs,
      });
      return {token: nextToken};
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BaseGoogleCredentialsConfig', () => {
  it.each([
    ['externalAccessTokenKey', {externalAccessTokenKey: 'token_key'}],
    ['clientId', {clientId: CLIENT_ID}],
    ['clientSecret', {clientSecret: CLIENT_SECRET}],
    ['scopes', {scopes: SCOPES}],
  ])('rejects credentials combined with %s', (_name, conflicting) => {
    expect(
      () =>
        new BaseGoogleCredentialsConfig({
          credentials: new OAuth2Client(),
          ...conflicting,
        }),
    ).toThrow(
      'If credentials are provided, externalAccessTokenKey, clientId, clientSecret, and scopes must not be provided.',
    );
  });

  it.each([
    ['clientId', {clientId: CLIENT_ID}],
    ['clientSecret', {clientSecret: CLIENT_SECRET}],
    ['scopes', {scopes: SCOPES}],
  ])(
    'rejects externalAccessTokenKey combined with %s',
    (_name, conflicting) => {
      expect(
        () =>
          new BaseGoogleCredentialsConfig({
            externalAccessTokenKey: 'token_key',
            ...conflicting,
          }),
      ).toThrow(
        'If externalAccessTokenKey is provided, clientId, clientSecret, and scopes must not be provided.',
      );
    },
  );

  it('rejects an empty configuration', () => {
    expect(() => new BaseGoogleCredentialsConfig()).toThrow(
      'Must provide one of credentials, externalAccessTokenKey, or a clientId and clientSecret pair.',
    );
  });

  it('rejects a clientId without a clientSecret', () => {
    expect(
      () => new BaseGoogleCredentialsConfig({clientId: CLIENT_ID}),
    ).toThrow(
      'Must provide one of credentials, externalAccessTokenKey, or a clientId and clientSecret pair.',
    );
  });

  it('accepts a pre-supplied credential on its own', () => {
    const credentials = new NonOAuth2Client();
    const config = new BaseGoogleCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
  });

  it('accepts an external access token key on its own', () => {
    const config = new BaseGoogleCredentialsConfig({
      externalAccessTokenKey: 'token_key',
    });

    expect(config.externalAccessTokenKey).toBe('token_key');
  });

  it('accepts a clientId and clientSecret pair', () => {
    const config = oauthConfig();

    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual(SCOPES);
  });

  it('back-fills the client identity from a supplied OAuth2 credential', () => {
    const credentials = new OAuth2Client({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    credentials.setCredentials({
      access_token: 'token',
      scope: 'scope-a scope-b',
    });

    const config = new BaseGoogleCredentialsConfig({credentials});

    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual(['scope-a', 'scope-b']);
  });

  it('does not back-fill from a credential that is not an OAuth2 client', () => {
    const config = new BaseGoogleCredentialsConfig({
      credentials: new NonOAuth2Client(),
    });

    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.scopes).toBeUndefined();
  });
});

describe('GoogleCredentialsManager', () => {
  describe('external access token', () => {
    it('builds a client from the token held in state', async () => {
      const state = new State();
      state.set('external_token', 'host-supplied-token');
      const {context, getAuthResponse} = createToolContext(state);
      const manager = new GoogleCredentialsManager(
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'external_token',
        }),
      );

      const client = await manager.getValidCredentials(context);

      expect(client?.credentials.access_token).toBe('host-supplied-token');
      expect(getAuthResponse).not.toHaveBeenCalled();
    });

    it('throws when state holds no token for the key', async () => {
      const {context} = createToolContext();
      const manager = new GoogleCredentialsManager(
        new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'external_token',
        }),
      );

      await expect(manager.getValidCredentials(context)).rejects.toThrow(
        'externalAccessTokenKey is provided but no access token found in tool context state with key external_token.',
      );
    });
  });

  describe('pre-supplied credentials', () => {
    it('returns a valid OAuth2 credential untouched', async () => {
      const credentials = new OAuth2Client({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });
      credentials.setCredentials({
        access_token: 'valid-token',
        expiry_date: Date.now() + HOUR_MS,
      });
      const {context, getAuthResponse, requestCredential} = createToolContext();
      const manager = new GoogleCredentialsManager(
        new BaseGoogleCredentialsConfig({credentials}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client).toBe(credentials);
      expect(getAuthResponse).not.toHaveBeenCalled();
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('mints a token for a non-OAuth2 credential that has none', async () => {
      const credentials = new NonOAuth2Client();
      const {context, requestCredential} = createToolContext();
      const manager = new GoogleCredentialsManager(
        new BaseGoogleCredentialsConfig({credentials}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client).toBe(credentials);
      expect(credentials.getAccessToken).toHaveBeenCalledTimes(1);
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('returns a non-OAuth2 credential even when minting a token fails', async () => {
      const credentials = new NonOAuth2Client();
      credentials.getAccessToken.mockRejectedValue(
        new Error('metadata server unreachable'),
      );
      const {context, requestCredential} = createToolContext();
      const manager = new GoogleCredentialsManager(
        new BaseGoogleCredentialsConfig({credentials}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client).toBe(credentials);
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('leaves a non-OAuth2 credential that already holds a token alone', async () => {
      const credentials = new NonOAuth2Client();
      credentials.setCredentials({access_token: 'still-good'});
      const {context} = createToolContext();
      const manager = new GoogleCredentialsManager(
        new BaseGoogleCredentialsConfig({credentials}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client).toBe(credentials);
      expect(credentials.getAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('token cache', () => {
    it('resolves a valid cached token without an OAuth flow', async () => {
      const state = new State();
      state.set(TOKEN_CACHE_KEY, {
        accessToken: 'cached-token',
        refreshToken: 'cached-refresh',
        expiryDate: Date.now() + HOUR_MS,
        scope: SCOPES.join(' '),
      });
      const {context, requestCredential} = createToolContext(state);
      const manager = new GoogleCredentialsManager(
        oauthConfig({tokenCacheKey: TOKEN_CACHE_KEY}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client?.credentials.access_token).toBe('cached-token');
      expect(client?.credentials.scope).toBe(SCOPES.join(' '));
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('refreshes an expired cached token and rewrites the cache', async () => {
      const refresh = stubTokenRefresh('refreshed-token');
      const state = new State();
      state.set(TOKEN_CACHE_KEY, {
        accessToken: 'stale-token',
        refreshToken: 'cached-refresh',
        expiryDate: Date.now() - HOUR_MS,
      });
      const {context, requestCredential} = createToolContext(state);
      const manager = new GoogleCredentialsManager(
        oauthConfig({tokenCacheKey: TOKEN_CACHE_KEY}),
      );

      const client = await manager.getValidCredentials(context);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(client?.credentials.access_token).toBe('refreshed-token');
      expect(state.get(TOKEN_CACHE_KEY)).toMatchObject({
        accessToken: 'refreshed-token',
        refreshToken: 'cached-refresh',
      });
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('starts an OAuth flow when the refresh fails', async () => {
      vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockRejectedValue(
        new Error('invalid_grant'),
      );
      const state = new State();
      state.set(TOKEN_CACHE_KEY, {
        accessToken: 'stale-token',
        refreshToken: 'revoked-refresh',
        expiryDate: Date.now() - HOUR_MS,
      });
      const {context, requestCredential} = createToolContext(state);
      const manager = new GoogleCredentialsManager(
        oauthConfig({tokenCacheKey: TOKEN_CACHE_KEY}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client).toBeUndefined();
      expect(requestCredential).toHaveBeenCalledTimes(1);
    });

    it('starts an OAuth flow when the refresh yields no usable token', async () => {
      const refresh = vi
        .spyOn(OAuth2Client.prototype, 'getAccessToken')
        .mockImplementation(async () => ({token: null}));
      const state = new State();
      state.set(TOKEN_CACHE_KEY, {
        accessToken: 'stale-token',
        refreshToken: 'cached-refresh',
        expiryDate: Date.now() - HOUR_MS,
      });
      const {context, requestCredential} = createToolContext(state);
      const manager = new GoogleCredentialsManager(
        oauthConfig({tokenCacheKey: TOKEN_CACHE_KEY}),
      );

      const client = await manager.getValidCredentials(context);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(client).toBeUndefined();
      expect(requestCredential).toHaveBeenCalledTimes(1);
    });

    it('starts an OAuth flow for an expired token with no refresh token', async () => {
      const state = new State();
      state.set(TOKEN_CACHE_KEY, {
        accessToken: 'stale-token',
        expiryDate: Date.now() - HOUR_MS,
      });
      const {context, requestCredential} = createToolContext(state);
      const manager = new GoogleCredentialsManager(
        oauthConfig({tokenCacheKey: TOKEN_CACHE_KEY}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client).toBeUndefined();
      expect(requestCredential).toHaveBeenCalledTimes(1);
    });

    it('carries a completed flow across manager instances via the cache', async () => {
      const {context, state, getAuthResponse, requestCredential} =
        createToolContext();
      getAuthResponse.mockReturnValue(
        oauthResponse({
          accessToken: 'flow-token',
          refreshToken: 'flow-refresh',
          expiresAt: Date.now() + HOUR_MS,
        }),
      );
      const first = new GoogleCredentialsManager(
        oauthConfig({tokenCacheKey: TOKEN_CACHE_KEY}),
      );
      await first.getValidCredentials(context);

      getAuthResponse.mockReturnValue(undefined);
      const second = new GoogleCredentialsManager(
        oauthConfig({tokenCacheKey: TOKEN_CACHE_KEY}),
      );
      const client = await second.getValidCredentials(context);

      expect(client?.credentials.access_token).toBe('flow-token');
      expect(state.get(TOKEN_CACHE_KEY)).toMatchObject({
        accessToken: 'flow-token',
      });
      expect(requestCredential).not.toHaveBeenCalled();
    });
  });

  describe('interactive OAuth flow', () => {
    it('requests a credential describing the Google authorization endpoints', async () => {
      const {context, requestCredential} = createToolContext();
      const manager = new GoogleCredentialsManager(oauthConfig());

      const client = await manager.getValidCredentials(context);

      expect(client).toBeUndefined();
      expect(requestCredential).toHaveBeenCalledTimes(1);
      const authConfig = requestCredential.mock.calls[0][0];
      expect(authConfig.authScheme.type).toBe('oauth2');
      if (authConfig.authScheme.type !== 'oauth2') {
        expect.fail('expected an oauth2 auth scheme');
      }
      expect(authConfig.authScheme.flows.authorizationCode).toEqual({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: {[SCOPES[0]]: `Access to ${SCOPES[0]}`},
      });
      expect(authConfig.rawAuthCredential?.oauth2).toEqual({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });
    });

    it('reads the response back under the credential key it requested', async () => {
      const {context, getAuthResponse, requestCredential} = createToolContext();
      const manager = new GoogleCredentialsManager(oauthConfig());

      await manager.getValidCredentials(context);

      expect(getAuthResponse.mock.calls[0][0].credentialKey).toBe(
        requestCredential.mock.calls[0][0].credentialKey,
      );
    });

    it('derives the same credential key for two equivalent configs', async () => {
      const {context: first, requestCredential: firstRequest} =
        createToolContext();
      const {context: second, requestCredential: secondRequest} =
        createToolContext();

      await new GoogleCredentialsManager(
        oauthConfig({scopes: ['scope-b', 'scope-a']}),
      ).getValidCredentials(first);
      await new GoogleCredentialsManager(
        oauthConfig({scopes: ['scope-a', 'scope-b']}),
      ).getValidCredentials(second);

      expect(firstRequest.mock.calls[0][0].credentialKey).toBe(
        secondRequest.mock.calls[0][0].credentialKey,
      );
    });

    it('requests a credential again when the response carries no OAuth2 payload', async () => {
      const {context, getAuthResponse, requestCredential} = createToolContext();
      getAuthResponse.mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'not-an-oauth-response',
      });
      const manager = new GoogleCredentialsManager(oauthConfig());

      const client = await manager.getValidCredentials(context);

      expect(client).toBeUndefined();
      expect(requestCredential).toHaveBeenCalledTimes(1);
    });

    it('builds a client from a completed flow and caches the token', async () => {
      const expiresAt = Date.now() + HOUR_MS;
      const {context, state, getAuthResponse} = createToolContext();
      getAuthResponse.mockReturnValue(
        oauthResponse({
          accessToken: 'flow-token',
          refreshToken: 'flow-refresh',
          expiresAt,
        }),
      );
      const manager = new GoogleCredentialsManager(
        oauthConfig({tokenCacheKey: TOKEN_CACHE_KEY}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client?.credentials).toMatchObject({
        access_token: 'flow-token',
        refresh_token: 'flow-refresh',
        expiry_date: expiresAt,
        scope: SCOPES.join(' '),
      });
      expect(state.get(TOKEN_CACHE_KEY)).toEqual({
        accessToken: 'flow-token',
        refreshToken: 'flow-refresh',
        expiryDate: expiresAt,
        scope: SCOPES.join(' '),
      });
    });

    it('writes nothing to state when no token cache key is configured', async () => {
      const {context, state, getAuthResponse} = createToolContext();
      getAuthResponse.mockReturnValue(
        oauthResponse({accessToken: 'flow-token'}),
      );
      const manager = new GoogleCredentialsManager(oauthConfig());

      const client = await manager.getValidCredentials(context);

      expect(client?.credentials.access_token).toBe('flow-token');
      expect(state.hasDelta()).toBe(false);
    });

    it('handles a config that declares no scopes', async () => {
      const {context, getAuthResponse, requestCredential} = createToolContext();
      const config = new BaseGoogleCredentialsConfig({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });
      const manager = new GoogleCredentialsManager(config);

      await manager.getValidCredentials(context);

      const authConfig = requestCredential.mock.calls[0][0];
      if (authConfig.authScheme.type !== 'oauth2') {
        expect.fail('expected an oauth2 auth scheme');
      }
      expect(authConfig.authScheme.flows.authorizationCode?.scopes).toEqual({});

      getAuthResponse.mockReturnValue(
        oauthResponse({accessToken: 'flow-token'}),
      );
      const client = await manager.getValidCredentials(context);

      expect(client?.credentials.scope).toBeUndefined();
    });

    it('falls back to a default credential key when the client id is unknown', async () => {
      const credentials = new OAuth2Client();
      credentials.setCredentials({
        access_token: 'expired-token',
        expiry_date: Date.now() - HOUR_MS,
      });
      const {context, requestCredential} = createToolContext();
      const manager = new GoogleCredentialsManager(
        new BaseGoogleCredentialsConfig({credentials}),
      );

      const client = await manager.getValidCredentials(context);

      expect(client).toBeUndefined();
      expect(requestCredential.mock.calls[0][0].credentialKey).toBe(
        'google_default_',
      );
    });
  });
});
