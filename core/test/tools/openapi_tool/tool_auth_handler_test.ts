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
  LlmAgent,
  PluginManager,
  ToolAuthHandler,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it, vi} from 'vitest';
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

  describe('user-interactive OAuth2 grants', () => {
    const FUNCTION_CALL_ID = 'function-call-1';

    const CLIENT_CREDENTIAL: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };

    const AUTHORIZATION_CODE_SCHEME: OpenAPIV3.SecuritySchemeObject = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    };

    // A real Context, so `requestCredential` mints the sign-in URI through the
    // production AuthHandler and records it on the event actions, and
    // `getAuthResponse` reads the client's answer back out of session state.
    function createToolContext(state: Record<string, unknown> = {}): Context {
      return new Context({
        invocationContext: new InvocationContext({
          invocationId: 'invocation-1',
          agent: new LlmAgent({name: 'test_agent'}),
          session: createSession({
            id: 'session-1',
            appName: 'app',
            userId: 'user',
            state,
          }),
          pluginManager: new PluginManager(),
        }),
        functionCallId: FUNCTION_CALL_ID,
      });
    }

    it('asks the client to sign in for the authorization-code grant', async () => {
      const context = createToolContext();

      const result = await new ToolAuthHandler(
        context,
        AUTHORIZATION_CODE_SCHEME,
        CLIENT_CREDENTIAL,
      ).prepareAuthCredentials();

      expect(result.state).toBe('pending');
      // The exchanger would have returned `exchanged-token`, so an absent
      // credential proves the exchanger never ran.
      expect(result.authCredential).toBeUndefined();
      const requested =
        context.eventActions.requestedAuthConfigs[FUNCTION_CALL_ID];
      expect(requested?.exchangedAuthCredential?.oauth2?.authUri).toContain(
        'client_id=client-id',
      );
    });

    it('exchanges a client-credentials credential without asking the user', async () => {
      const context = createToolContext();

      const result = await new ToolAuthHandler(
        context,
        {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://example.com/token',
              scopes: {},
            },
          },
        },
        CLIENT_CREDENTIAL,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential?.http?.credentials.token).toBe(
        'exchanged-token',
      );
      expect(context.eventActions.requestedAuthConfigs).toEqual({});
    });

    it('uses a configured OAuth2 credential that already carries an access token', async () => {
      const context = createToolContext();

      const result = await new ToolAuthHandler(
        context,
        AUTHORIZATION_CODE_SCHEME,
        {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            ...CLIENT_CREDENTIAL.oauth2,
            accessToken: 'preprovisioned-token',
          },
        },
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(context.eventActions.requestedAuthConfigs).toEqual({});
    });

    it('uses a configured bearer credential on an authorization-code scheme', async () => {
      const context = createToolContext();

      const result = await new ToolAuthHandler(
        context,
        AUTHORIZATION_CODE_SCHEME,
        {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'static-token'}},
        },
      ).prepareAuthCredentials();

      // Only an OAuth2/OIDC credential needs a token minted for it; a bearer
      // token the developer already holds authorizes the request as it is.
      expect(result.state).toBe('done');
      expect(context.eventActions.requestedAuthConfigs).toEqual({});
    });

    it('exchanges the credential the client returned after signing in', async () => {
      // What the client fills in on the second leg: AuthHandler reads the auth
      // response from this session state key.
      const context = createToolContext({
        'temp:default_openapi_key': {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            ...CLIENT_CREDENTIAL.oauth2,
            authResponseUri: 'https://example.com/callback?code=abc',
          },
        },
      });

      const result = await new ToolAuthHandler(
        context,
        AUTHORIZATION_CODE_SCHEME,
        CLIENT_CREDENTIAL,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential?.http?.credentials.token).toBe(
        'exchanged-token',
      );
      const stored = context.state.get<AuthCredential>(
        'oauth2_existing_exchanged_credential',
      );
      expect(stored?.http?.credentials.token).toBe('exchanged-token');
    });

    it('asks the client to sign in for an OAuth2 credential with no oauth2 field', async () => {
      const context = createToolContext();

      const prepared = new ToolAuthHandler(context, AUTHORIZATION_CODE_SCHEME, {
        authType: AuthCredentialTypes.OAUTH2,
      }).prepareAuthCredentials();

      // A credential this malformed authorizes nothing, so it takes the
      // sign-in path and hits AuthHandler's own validation there. Reading it
      // must not raise a TypeError of its own.
      await expect(prepared).rejects.toThrowError(
        'Auth Scheme oauth2 requires oauth2 in authCredential.',
      );
    });

    it('leaves an unclassifiable oauth2 scheme to the exchanger', async () => {
      const context = createToolContext();

      const result = await new ToolAuthHandler(
        context,
        {type: 'oauth2', flows: {}},
        CLIENT_CREDENTIAL,
      ).prepareAuthCredentials();

      // Fail open: a scheme whose grant type cannot be determined keeps its
      // existing behaviour rather than stranding the tool in `pending`.
      expect(result.state).toBe('done');
      expect(context.eventActions.requestedAuthConfigs).toEqual({});
    });
  });
});
