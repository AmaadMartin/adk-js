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
  describe('credentialKey namespacing', () => {
    const API_KEY_SCHEME = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    } as const;

    it('does not read a credential cached under another credentialKey', async () => {
      const state = new State({
        'server_a_existing_exchanged_credential': {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'server-a-token'}},
        },
      });
      const mockContext = {
        state,
        getAuthResponse: vi.fn().mockReturnValue(undefined),
        requestCredential: vi.fn(),
      } as unknown as Context;

      const result = await new ToolAuthHandler(
        mockContext,
        API_KEY_SCHEME,
        undefined,
        'server_b',
      ).prepareAuthCredentials();

      expect(result.state).toBe('pending');
      expect(mockContext.requestCredential).toHaveBeenCalled();
    });

    it('reads the credential cached under its own credentialKey', async () => {
      const state = new State({
        'server_a_existing_exchanged_credential': {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'server-a-token'}},
        },
      });
      const mockContext = {
        state,
        getAuthResponse: vi.fn().mockReturnValue(undefined),
        requestCredential: vi.fn(),
      } as unknown as Context;

      const result = await new ToolAuthHandler(
        mockContext,
        API_KEY_SCHEME,
        undefined,
        'server_a',
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(result.authCredential?.http?.credentials.token).toBe(
        'server-a-token',
      );
    });

    it('writes an exchanged credential under its credentialKey', async () => {
      const state = new State();
      const mockContext = {
        state,
        getAuthResponse: vi.fn().mockReturnValue({
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'key',
        }),
        requestCredential: vi.fn(),
      } as unknown as Context;

      await new ToolAuthHandler(
        mockContext,
        API_KEY_SCHEME,
        undefined,
        'server_a',
      ).prepareAuthCredentials();

      expect(state.get('server_a_existing_exchanged_credential')).toBeDefined();
      expect(state.get('apiKey_existing_exchanged_credential')).toBeUndefined();
    });

    it('keeps the scheme-type slot when no credentialKey is given', async () => {
      const state = new State();
      const mockContext = {
        state,
        getAuthResponse: vi.fn().mockReturnValue({
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'key',
        }),
        requestCredential: vi.fn(),
      } as unknown as Context;

      await new ToolAuthHandler(
        mockContext,
        API_KEY_SCHEME,
      ).prepareAuthCredentials();

      expect(state.get('apiKey_existing_exchanged_credential')).toBeDefined();
    });
  });
  describe('oauth2 consent', () => {
    const AUTHORIZATION_CODE_SCHEME = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/o/oauth2/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {'read:things': 'read'},
        },
      },
    } as const;

    function createMockContext(state = new State()) {
      return {
        state,
        getAuthResponse: vi.fn().mockReturnValue(undefined),
        requestCredential: vi.fn(),
      } as unknown as Context;
    }

    it('requests consent for a credential holding only client details', async () => {
      const mockContext = createMockContext();

      const result = await new ToolAuthHandler(
        mockContext,
        AUTHORIZATION_CODE_SCHEME,
        {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
        },
      ).prepareAuthCredentials();

      expect(result.state).toBe('pending');
      expect(mockContext.requestCredential).toHaveBeenCalled();
    });

    it('does not request consent once an access token is present', async () => {
      const mockContext = createMockContext();

      const result = await new ToolAuthHandler(
        mockContext,
        AUTHORIZATION_CODE_SCHEME,
        {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'client-id', accessToken: 'token'},
        },
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(mockContext.requestCredential).not.toHaveBeenCalled();
    });

    it('does not request consent once an authorization code is present', async () => {
      const mockContext = createMockContext();

      const result = await new ToolAuthHandler(
        mockContext,
        AUTHORIZATION_CODE_SCHEME,
        {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            authCode: 'code',
          },
        },
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(mockContext.requestCredential).not.toHaveBeenCalled();
    });

    it('does not request consent for a client credentials grant', async () => {
      const mockContext = createMockContext();

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
      expect(mockContext.requestCredential).not.toHaveBeenCalled();
    });

    it('requests consent when an oauth2 credential has no oauth2 details', async () => {
      const mockContext = createMockContext();

      const result = await new ToolAuthHandler(
        mockContext,
        AUTHORIZATION_CODE_SCHEME,
        {authType: AuthCredentialTypes.OAUTH2},
      ).prepareAuthCredentials();

      expect(result.state).toBe('pending');
      expect(mockContext.requestCredential).toHaveBeenCalled();
    });

    it('does not request consent for a non-oauth2 scheme', async () => {
      const mockContext = createMockContext();

      const result = await new ToolAuthHandler(
        mockContext,
        {type: 'http', scheme: 'bearer'},
        {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'token'}},
        },
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(mockContext.requestCredential).not.toHaveBeenCalled();
    });

    it('requests consent for an openIdConnect credential with no token', async () => {
      const mockContext = createMockContext();

      const result = await new ToolAuthHandler(
        mockContext,
        {
          type: 'openIdConnect',
          openIdConnectUrl:
            'https://example.com/.well-known/openid-configuration',
        },
        {
          authType: AuthCredentialTypes.OPEN_ID_CONNECT,
          oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
        },
      ).prepareAuthCredentials();

      expect(result.state).toBe('pending');
      expect(mockContext.requestCredential).toHaveBeenCalled();
    });
  });
});
