/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  ToolAuthHandler,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
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

    const handler = new ToolAuthHandler(mockContext, {type: 'apiKey'});

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

    const handler = new ToolAuthHandler(mockContext, {type: 'apiKey'});

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

    const handler = new ToolAuthHandler(mockContext, {type: 'apiKey'});

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

    const handler = new ToolAuthHandler(mockContext, {type: 'apiKey'});

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

  describe('stored credential refresh', () => {
    const OAUTH2_SCHEME: OpenAPIV3.SecuritySchemeObject = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    };

    function storedOAuth2Credential(expiresAt: number): AuthCredential {
      return {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          accessToken: 'stale-token',
          refreshToken: 'old-refresh',
          expiresAt,
        },
      };
    }

    function seedStore(credential: AuthCredential) {
      const state = new State({
        oauth2_existing_exchanged_credential: credential,
      });
      const context = {state} as unknown as Context;

      return {state, context};
    }

    function stubFetch(buildResponse: () => Response) {
      const fetchMock = vi.fn<typeof fetch>(async () => buildResponse());
      vi.stubGlobal('fetch', fetchMock);

      return fetchMock;
    }

    function tokenResponse(body: Record<string, unknown>): Response {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('refreshes an expired OAuth2 credential read from the credential store', async () => {
      const fetchMock = stubFetch(() =>
        tokenResponse({
          access_token: 'refreshed-token',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      );
      const {context} = seedStore(storedOAuth2Credential(Date.now() - 1000));

      const result = await new ToolAuthHandler(
        context,
        OAUTH2_SCHEME,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential?.oauth2?.accessToken).toBe(
        'refreshed-token',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://example.com/token');
      const requestBody = new URLSearchParams(String(init?.body));
      expect(requestBody.get('grant_type')).toBe('refresh_token');
      expect(requestBody.get('refresh_token')).toBe('old-refresh');
    });

    it('persists the refreshed credential so the next call does not reuse a rotated refresh token', async () => {
      stubFetch(() =>
        tokenResponse({
          access_token: 'refreshed-token',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      );
      const {state, context} = seedStore(
        storedOAuth2Credential(Date.now() - 1000),
      );

      await new ToolAuthHandler(
        context,
        OAUTH2_SCHEME,
      ).prepareAuthCredentials();

      const stored = state.get<AuthCredential>(
        'oauth2_existing_exchanged_credential',
      );
      expect(stored?.oauth2?.accessToken).toBe('refreshed-token');
      expect(stored?.oauth2?.refreshToken).toBe('new-refresh');
      // Recorded in the delta, so the session keeps the rotated refresh token.
      expect(state.hasDelta()).toBe(true);
    });

    it('returns a stored OAuth2 credential that has not expired without refreshing', async () => {
      const fetchMock = stubFetch(() => tokenResponse({}));
      const {state, context} = seedStore(
        storedOAuth2Credential(Date.now() + 3_600_000),
      );

      const result = await new ToolAuthHandler(
        context,
        OAUTH2_SCHEME,
      ).prepareAuthCredentials();

      expect(result.authCredential?.oauth2?.accessToken).toBe('stale-token');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.hasDelta()).toBe(false);
    });

    it('does not attempt to refresh a stored non-OAuth2 credential', async () => {
      const fetchMock = stubFetch(() => tokenResponse({}));
      const {state, context} = seedStore({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'sa-token'}},
      });

      const result = await new ToolAuthHandler(
        context,
        OAUTH2_SCHEME,
      ).prepareAuthCredentials();

      expect(result.authCredential?.http?.credentials.token).toBe('sa-token');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.hasDelta()).toBe(false);
    });

    it('returns the stored credential unchanged when the refresh request fails', async () => {
      stubFetch(() => new Response('', {status: 500}));
      const {context} = seedStore(storedOAuth2Credential(Date.now() - 1000));

      const result = await new ToolAuthHandler(
        context,
        OAUTH2_SCHEME,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential?.oauth2?.accessToken).toBe('stale-token');
    });
  });
});
