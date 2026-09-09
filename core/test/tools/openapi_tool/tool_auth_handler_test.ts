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
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ExchangeResult} from '../../../src/auth/exchanger/base_credential_exchanger.js';
import {State} from '../../../src/sessions/state.js';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';

const exchange = vi.hoisted(() => vi.fn<() => Promise<ExchangeResult>>());

// Mock AutoAuthCredentialExchanger
vi.mock(
  '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js',
  () => {
    return {
      AutoAuthCredentialExchanger: vi
        .fn()
        .mockImplementation(() => ({exchange})),
    };
  },
);

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

const API_KEY_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const UNEXCHANGED_OAUTH2_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'key',
};

/**
 * Builds a real Context whose session state already holds the credential that
 * `Context.getAuthResponse()` reads back, which is how a client supplies a
 * credential interactively.
 */
function createContextWithAuthResponse(credential: AuthCredential): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        state: {'temp:default_openapi_key': credential},
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('ToolAuthHandler', () => {
  beforeEach(() => {
    exchange.mockResolvedValue({
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
      },
      wasExchanged: true,
    });
  });

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

  describe('with a degraded exchange', () => {
    it('does not cache an OAuth2 credential whose exchange failed', async () => {
      exchange.mockResolvedValue({
        credential: UNEXCHANGED_OAUTH2_CREDENTIAL,
        wasExchanged: false,
      });
      const context = createContextWithAuthResponse(
        UNEXCHANGED_OAUTH2_CREDENTIAL,
      );
      const handler = new ToolAuthHandler(context, OAUTH2_SCHEME);

      const result = await handler.prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential).toBe(UNEXCHANGED_OAUTH2_CREDENTIAL);
      expect(
        context.state.get('oauth2_existing_exchanged_credential'),
      ).toBeUndefined();
      expect(context.state.hasDelta()).toBe(false);
    });

    it('caches an auth response credential that needs no external exchange', async () => {
      exchange.mockResolvedValue({
        credential: API_KEY_CREDENTIAL,
        wasExchanged: false,
      });
      const context = createContextWithAuthResponse(API_KEY_CREDENTIAL);
      const handler = new ToolAuthHandler(context, API_KEY_SCHEME);

      const result = await handler.prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(context.state.get('apiKey_existing_exchanged_credential')).toBe(
        API_KEY_CREDENTIAL,
      );
      expect(context.state.hasDelta()).toBe(true);
    });

    it('caches an OAuth2 credential that was exchanged', async () => {
      const exchanged: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {...UNEXCHANGED_OAUTH2_CREDENTIAL.oauth2, accessToken: 'token'},
      };
      exchange.mockResolvedValue({credential: exchanged, wasExchanged: true});
      const context = createContextWithAuthResponse(
        UNEXCHANGED_OAUTH2_CREDENTIAL,
      );
      const handler = new ToolAuthHandler(context, OAUTH2_SCHEME);

      const result = await handler.prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(context.state.get('oauth2_existing_exchanged_credential')).toBe(
        exchanged,
      );
      expect(context.state.hasDelta()).toBe(true);
    });
  });
});
