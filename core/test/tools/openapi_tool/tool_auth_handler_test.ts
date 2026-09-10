/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  OpenIdConnectWithConfig,
  ToolAuthHandler,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {State} from '../../../src/sessions/state.js';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';

// Mock AutoAuthCredentialExchanger
vi.mock(
  '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js',
  () => {
    return {
      AutoAuthCredentialExchanger: vi.fn().mockImplementation(() => ({
        exchange: vi.fn().mockResolvedValue({
          credential: {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
          },
          wasExchanged: true,
        }),
      })),
    };
  },
);

describe('ToolAuthHandler', () => {
  it('should return done if no auth scheme', async () => {
    const mockContext = {} as unknown as Context;
    const handler = new ToolAuthHandler(mockContext);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential).toBeUndefined();
  });

  it('should return done after exchange if credential in context', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
  });

  it('should return pending and request credential if not in context', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(mockContext.requestCredential).toHaveBeenCalled();
  });

  it('should return cached credential if available', async () => {
    const mockContext = {
      state: new State({
        'apiKey_existing_exchanged_credential': {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'cached-token'}},
        },
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe('cached-token');
  });

  it('should store exchanged credential in state and record it in the delta', async () => {
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    // Stored via the State API so it is readable back through State.get...
    const stored = state.get<{http?: {credentials: {token: string}}}>(
      'apiKey_existing_exchanged_credential',
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
    // ...and recorded in the delta so it is persisted to the session (rather
    // than being re-exchanged on every subsequent tool call).
    expect(state.hasDelta()).toBe(true);
  });

  it('re-uses a credential persisted by a previous tool call instead of re-exchanging', async () => {
    // First invocation: exchange and store the credential.
    const firstState = new State();
    const firstContext = {
      state: firstState,
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;
    await new ToolAuthHandler(firstContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    }).prepareAuthCredentials();

    // Each tool call gets a fresh Context whose State is rebuilt from the
    // values persisted to the session. Only what was recorded in the state
    // delta/value survives this round-trip (a stray own-property would not).
    const secondState = new State(firstState.toRecord());
    const secondContext = {
      state: secondState,
      getAuthResponse: vi.fn(),
    } as unknown as Context;
    const result = await new ToolAuthHandler(secondContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    }).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
    // The cached credential was reused; no second exchange was triggered.
    expect(secondContext.getAuthResponse).not.toHaveBeenCalled();
  });

  it('uses the credential the tool was configured with instead of requesting one', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      {authType: AuthCredentialTypes.API_KEY, apiKey: 'static-key'},
    ).prepareAuthCredentials();

    // Schemes like apiKey need no user interaction, so asking the client for a
    // credential would leave the tool stuck in `pending` forever.
    expect(result.state).toBe('done');
    expect(mockContext.requestCredential).not.toHaveBeenCalled();
  });

  it('does not copy a static credential that needed no exchange into session state', async () => {
    const staticCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'static-key',
    };
    // The real exchanger has no exchanger registered for apiKey/http, so it
    // hands the credential straight back.
    vi.mocked(AutoAuthCredentialExchanger).mockImplementationOnce(
      () =>
        ({
          exchange: vi.fn().mockResolvedValue({
            credential: staticCredential,
            wasExchanged: false,
          }),
        }) as unknown as AutoAuthCredentialExchanger,
    );

    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      staticCredential,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.apiKey).toBe('static-key');
    // It is readable from the tool on every invocation, so persisting it would
    // only write the secret into the session store for nothing.
    expect(state.get('apiKey_existing_exchanged_credential')).toBeUndefined();
    expect(state.hasDelta()).toBe(false);
  });

  it('caches a static credential that did require an exchange', async () => {
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://example.com/token',
            scopes: {},
          },
        },
      },
      {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
      },
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    // An exchange costs a round trip, so its result is worth persisting.
    const stored = state.get<{http?: {credentials: {token: string}}}>(
      'oauth2_existing_exchanged_credential',
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
  });

  describe('cached OAuth2 credential', () => {
    const OIDC_STORE_KEY = 'openIdConnect_existing_exchanged_credential';
    const TOKEN_ENDPOINT = 'https://example.com/token';

    // `https://example.com` passes the SSRF allowlist `fetchOAuth2Tokens`
    // applies, so the refresher reaches the (stubbed) network call.
    const oidcScheme: OpenIdConnectWithConfig = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      authorizationEndpoint: 'https://example.com/authorize',
      tokenEndpoint: TOKEN_ENDPOINT,
    };

    function cachedCredential(expiresAt: number): AuthCredential {
      return {
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          accessToken: 'stale-token',
          refreshToken: 'stale-refresh',
          expiresAt,
        },
      };
    }

    // The handler reads only `state`, `getAuthResponse` and
    // `requestCredential`, so these tests build a partial Context in one
    // place, the way the rest of this file does inline.
    function fakeContext(parts: Partial<Context>): Context {
      return parts as unknown as Context;
    }

    let restoreFetch: (() => void) | undefined;

    function stubTokenEndpoint(response: Response) {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
      restoreFetch = () => spy.mockRestore();
      return spy;
    }

    function freshTokenResponse(): Response {
      return new Response(
        JSON.stringify({
          access_token: 'fresh-token',
          refresh_token: 'rotated-token',
          expires_in: 3600,
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      );
    }

    // Restore only the fetch spy: `vi.restoreAllMocks()` would also reset the
    // module mock of AutoAuthCredentialExchanger that the whole file shares.
    afterEach(() => {
      restoreFetch?.();
      restoreFetch = undefined;
    });

    it('refreshes an expired cached OAuth2 credential before using it', async () => {
      const fetchSpy = stubTokenEndpoint(freshTokenResponse());
      const mockContext = fakeContext({
        state: new State({
          [OIDC_STORE_KEY]: cachedCredential(Date.now() - 1000),
        }),
      });

      const result = await new ToolAuthHandler(
        mockContext,
        oidcScheme,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential?.oauth2?.accessToken).toBe('fresh-token');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(TOKEN_ENDPOINT);
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      expect(String(init?.body)).toContain('refresh_token=stale-refresh');
    });

    it('persists the refreshed tokens so the next call does not reuse the old refresh token', async () => {
      stubTokenEndpoint(freshTokenResponse());
      const state = new State({
        [OIDC_STORE_KEY]: cachedCredential(Date.now() - 1000),
      });
      const mockContext = fakeContext({state});

      await new ToolAuthHandler(
        mockContext,
        oidcScheme,
      ).prepareAuthCredentials();

      const stored = state.get<AuthCredential>(OIDC_STORE_KEY);
      expect(stored?.oauth2?.accessToken).toBe('fresh-token');
      expect(stored?.oauth2?.refreshToken).toBe('rotated-token');
      expect(state.hasDelta()).toBe(true);
    });

    it('does not refresh a cached OAuth2 credential that is still valid', async () => {
      const fetchSpy = stubTokenEndpoint(freshTokenResponse());
      // `isTokenExpired` applies a 60s leeway, so a valid fixture must expire
      // more than a minute from now.
      const valid = cachedCredential(Date.now() + 3_600_000);
      const state = new State({[OIDC_STORE_KEY]: valid});
      const mockContext = fakeContext({state});

      const result = await new ToolAuthHandler(
        mockContext,
        oidcScheme,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential?.oauth2?.accessToken).toBe('stale-token');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(state.hasDelta()).toBe(false);
    });

    it('keeps the cached credential when the refresh request fails', async () => {
      stubTokenEndpoint(new Response('{}', {status: 400}));
      const mockContext = fakeContext({
        state: new State({
          [OIDC_STORE_KEY]: cachedCredential(Date.now() - 1000),
        }),
      });

      const result = await new ToolAuthHandler(
        mockContext,
        oidcScheme,
      ).prepareAuthCredentials();

      // adk-python keeps the stale credential too: the call then fails at the
      // API rather than here.
      expect(result.state).toBe('done');
      expect(result.authCredential?.oauth2?.accessToken).toBe('stale-token');
    });

    it('re-enters the auth flow when the cached credential has no access token', async () => {
      const tokenless: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
      };
      const mockContext = fakeContext({
        state: new State({[OIDC_STORE_KEY]: tokenless}),
        getAuthResponse: vi.fn().mockReturnValue(undefined),
        requestCredential: vi.fn(),
      });

      const result = await new ToolAuthHandler(
        mockContext,
        oidcScheme,
      ).prepareAuthCredentials();

      expect(result.state).toBe('pending');
      expect(mockContext.requestCredential).toHaveBeenCalled();
    });

    it('exchanges a fresh auth response when the cached credential has no access token', async () => {
      const tokenless: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
      };
      const state = new State({[OIDC_STORE_KEY]: tokenless});
      const mockContext = fakeContext({
        state,
        getAuthResponse: vi.fn().mockReturnValue({
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            authCode: 'auth-code',
          },
        }),
        requestCredential: vi.fn(),
      });

      const result = await new ToolAuthHandler(
        mockContext,
        oidcScheme,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential?.http?.credentials.token).toBe(
        'exchanged-token',
      );
      const stored = state.get<AuthCredential>(OIDC_STORE_KEY);
      expect(stored?.http?.credentials.token).toBe('exchanged-token');
    });
  });
});
