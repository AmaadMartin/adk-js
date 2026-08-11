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

/** Matches a cache key derived from a scheme, with or without a credential. */
const IDENTITY_KEY_PATTERN =
  /^[a-zA-Z0-9]+_[0-9a-f]{16}_([a-zA-Z0-9]+_[0-9a-f]{16})?_existing_exchanged_credential$/;

/**
 * Builds the Context a single tool call gets. `sessionState` is the record the
 * session holds, so a credential cached by one call is visible to the next.
 */
function createContext(sessionState: Record<string, unknown>): Context {
  return new Context({
    invocationContext: {
      session: {state: sessionState},
      agent: {name: 'tool-auth-handler-agent'},
    } as unknown as InvocationContext,
  });
}

function cachedCredentialKeys(sessionState: Record<string, unknown>): string[] {
  return Object.keys(sessionState).filter((key) =>
    IDENTITY_KEY_PATTERN.test(key),
  );
}

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

  it('ignores a credential stored under the pre-upgrade key', async () => {
    // The pre-upgrade key names only the scheme type, so it cannot say which
    // tool cached the credential. Serving it would hand one tool's token to
    // another, which is the defect this key format exists to close.
    const sessionState: Record<string, unknown> = {
      'apiKey_existing_exchanged_credential': {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'pre-upgrade-token'}},
      },
    };

    const result = await new ToolAuthHandler(
      createContext(sessionState),
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      {authType: AuthCredentialTypes.API_KEY, apiKey: 'static-key'},
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
    expect(cachedCredentialKeys(sessionState)).toHaveLength(1);
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
    const [key, ...otherKeys] = Object.keys(state.toRecord());
    expect(otherKeys).toEqual([]);
    // ...under a key that identifies the scheme, with an empty credential
    // segment because the tool was configured with no credential.
    expect(key).toMatch(/^apiKey_[0-9a-f]{16}__existing_exchanged_credential$/);
    const stored = state.get<{http?: {credentials: {token: string}}}>(key);
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
    const [key, ...otherKeys] = Object.keys(state.toRecord());
    expect(otherKeys).toEqual([]);
    // Both the scheme and the configured credential identify the slot.
    expect(key).toMatch(
      /^oauth2_[0-9a-f]{16}_oauth2_[0-9a-f]{16}_existing_exchanged_credential$/,
    );
    const stored = state.get<{http?: {credentials: {token: string}}}>(key);
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
  });

  it('gives two oauth2 tools with different token URLs their own cache slot', async () => {
    const schemeA: OpenAPIV3.SecuritySchemeObject = {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: 'https://a.example.com/token',
          scopes: {},
        },
      },
    };
    const schemeB: OpenAPIV3.SecuritySchemeObject = {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: 'https://b.example.com/token',
          scopes: {},
        },
      },
    };
    const sessionState: Record<string, unknown> = {};

    await new ToolAuthHandler(createContext(sessionState), schemeA, {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-a', clientSecret: 'secret-a'},
    }).prepareAuthCredentials();
    const result = await new ToolAuthHandler(
      createContext(sessionState),
      schemeB,
      {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client-b', clientSecret: 'secret-b'},
      },
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    // Tool B exchanged its own credential rather than being served tool A's,
    // so the session holds a credential per tool.
    expect(cachedCredentialKeys(sessionState)).toHaveLength(2);
  });

  it('gives two apiKey tools with different scheme names their own cache slot', async () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key',
    };
    const sessionState: Record<string, unknown> = {};

    await new ToolAuthHandler(
      createContext(sessionState),
      {type: 'apiKey', name: 'X-A-Key', in: 'header'},
      credential,
    ).prepareAuthCredentials();
    const result = await new ToolAuthHandler(
      createContext(sessionState),
      {type: 'apiKey', name: 'X-B-Key', in: 'header'},
      credential,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(cachedCredentialKeys(sessionState)).toHaveLength(2);
  });

  it('reuses the cached credential when only the redirect URI differs', async () => {
    const scheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    };
    const sessionState: Record<string, unknown> = {};

    await new ToolAuthHandler(createContext(sessionState), scheme, {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'http://localhost:8001/oauth2callback',
      },
    }).prepareAuthCredentials();

    // The same tool behind a different callback URL, e.g. after the agent
    // moves from a laptop to a hosted deployment, and after a fresh consent
    // round trip supplied a new PKCE verifier.
    const result = await new ToolAuthHandler(
      createContext(sessionState),
      scheme,
      {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'https://deployed.example.com/oauth2callback',
          codeVerifier: 'verifier-from-the-second-round-trip',
          state: 'state-from-the-second-round-trip',
        },
      },
    ).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
    // One slot, so the second tool read the credential the first one cached.
    expect(cachedCredentialKeys(sessionState)).toHaveLength(1);
  });

  it('gives two tools configured with different access tokens their own cache slot', async () => {
    const scheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'oauth2',
      flows: {
        clientCredentials: {tokenUrl: 'https://example.com/token', scopes: {}},
      },
    };
    const sessionState: Record<string, unknown> = {};

    // A token the tool was configured with is the credential, not round-trip
    // state, so it has to reach the key.
    await new ToolAuthHandler(createContext(sessionState), scheme, {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client', accessToken: 'token-a'},
    }).prepareAuthCredentials();
    await new ToolAuthHandler(createContext(sessionState), scheme, {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client', accessToken: 'token-b'},
    }).prepareAuthCredentials();

    expect(cachedCredentialKeys(sessionState)).toHaveLength(2);
  });

  it('caches the exchanged credential under the configured credential key', async () => {
    // The client answered the credential request, which ADK reads back from
    // the `temp:`-namespaced request slot.
    const sessionState: Record<string, unknown> = {
      'temp:my_tool_tokens': {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      } satisfies AuthCredential,
    };
    const context = createContext(sessionState);

    const result = await new ToolAuthHandler(
      context,
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      undefined,
      'my_tool_tokens',
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    // The cache slot is exactly the configured key, with no derived key
    // written alongside it, and it does not collide with the request slot.
    expect(Object.keys(sessionState)).toEqual([
      'temp:my_tool_tokens',
      'my_tool_tokens',
    ]);
    expect(
      context.state.get<AuthCredential>('my_tool_tokens')?.http?.credentials
        .token,
    ).toBe('exchanged-token');
  });

  it('reads back a credential cached under the same override by a different scheme', async () => {
    const sessionState: Record<string, unknown> = {};
    const staticCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'static-key',
    };

    await new ToolAuthHandler(
      createContext(sessionState),
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      staticCredential,
      'shared_tool_tokens',
    ).prepareAuthCredentials();

    const second = await new ToolAuthHandler(
      createContext(sessionState),
      {type: 'http', scheme: 'bearer'},
      staticCredential,
      'shared_tool_tokens',
    ).prepareAuthCredentials();

    expect(second.state).toBe('done');
    expect(second.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
    // One slot: the second handler read the first one's credential instead of
    // exchanging into a slot of its own.
    expect(Object.keys(sessionState)).toEqual(['shared_tool_tokens']);
  });

  it('gives two tools with different credential keys their own cache slot', async () => {
    const scheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const staticCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'static-key',
    };
    const sessionState: Record<string, unknown> = {};

    await new ToolAuthHandler(
      createContext(sessionState),
      scheme,
      staticCredential,
      'tool_a_tokens',
    ).prepareAuthCredentials();
    await new ToolAuthHandler(
      createContext(sessionState),
      scheme,
      staticCredential,
      'tool_b_tokens',
    ).prepareAuthCredentials();

    expect(Object.keys(sessionState)).toEqual([
      'tool_a_tokens',
      'tool_b_tokens',
    ]);
  });

  it('falls back to the derived key when the credential key is empty', async () => {
    const sessionState: Record<string, unknown> = {};

    const result = await new ToolAuthHandler(
      createContext(sessionState),
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      {authType: AuthCredentialTypes.API_KEY, apiKey: 'static-key'},
      '',
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    // An empty string names no slot, so the scheme and the credential still do.
    expect(Object.keys(sessionState)).toHaveLength(1);
    expect(cachedCredentialKeys(sessionState)).toEqual(
      Object.keys(sessionState),
    );
  });
});
