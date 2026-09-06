/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialMissingError,
  AuthCredentialTypes,
  AuthScheme,
  Context,
  createSession,
  CredentialStore,
  InvocationContext,
  OAuth2Auth,
  PluginManager,
  ToolAuthHandler,
  ToolContextCredentialStore,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {State} from '../../../src/sessions/state.js';
import {logger} from '../../../src/utils/logger.js';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'api-key',
};

const OIDC_SCHEME: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://provider.example.com/.well-known/openid-config',
  authorizationEndpoint: 'https://provider.example.com/authorize',
  tokenEndpoint: 'https://provider.example.com/token',
};

const EXCHANGED_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
};

function oidcCredential(oauth2: OAuth2Auth = {}): AuthCredential {
  return {
    authType: AuthCredentialTypes.OPEN_ID_CONNECT,
    oauth2: {clientId: 'client-id', clientSecret: 'client-secret', ...oauth2},
  };
}

const OIDC_CREDENTIAL = oidcCredential();

/** A tool context whose session state already holds `state`. */
function createContext(state: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        state: {...state},
      }),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'call-1',
  });
}

/** Returns the state a context needs so the store already holds `credential`. */
async function seededStore(
  configured: AuthCredential,
  credential: AuthCredential,
  authScheme: AuthScheme,
): Promise<Record<string, unknown>> {
  const key = await new ToolContextCredentialStore(
    createContext(),
  ).getCredentialKey(authScheme, configured);
  return {[key]: credential};
}

async function storedCredential(
  context: Context,
  configured: AuthCredential,
  authScheme: AuthScheme = OIDC_SCHEME,
): Promise<AuthCredential | undefined> {
  const key = await new ToolContextCredentialStore(context).getCredentialKey(
    authScheme,
    configured,
  );
  return context.state.get<AuthCredential>(key);
}

/** Returns the key the credential the handler asked for is filed under. */
function requestedKey(context: Context): string | undefined {
  return context.eventActions.requestedAuthConfigs['call-1']?.credentialKey;
}

function recordingExchanger(credential: AuthCredential) {
  return {
    exchange: vi.fn().mockResolvedValue({credential, wasExchanged: true}),
  };
}

/** A store that keeps one credential in memory, under a fixed key. */
class FakeCredentialStore implements CredentialStore {
  static readonly KEY = 'fake-store-key';
  readonly entries = new Map<string, AuthCredential>();
  getCredentialCalls = 0;

  async getCredentialKey(): Promise<string> {
    return FakeCredentialStore.KEY;
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    this.getCredentialCalls += 1;
    return this.entries.get(FakeCredentialStore.KEY);
  }

  async storeCredential(
    key: string,
    credential: AuthCredential,
  ): Promise<void> {
    this.entries.set(key, credential);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A token endpoint response body, as `fetchOAuth2Tokens` parses it. */
function tokenResponse(body: Record<string, unknown>) {
  return {ok: true, status: 200, json: async () => body};
}

/** An exchanger that returns the credential it was given, as the real one
 * does for a credential type it has no exchanger for. */
function passThroughExchanger() {
  return {
    exchange: vi
      .fn()
      .mockImplementation(
        async ({authCredential}: {authCredential: AuthCredential}) => ({
          credential: authCredential,
          wasExchanged: false,
        }),
      ),
  };
}

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
    // A cached credential is handed back to the exchanger, which has nothing
    // registered for an http credential and returns it unchanged.
    const scheme: AuthScheme = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const context = createContext();
    // Derive the key instead of hardcoding it, so this pins the caching
    // behaviour rather than the key format.
    const key = await new ToolContextCredentialStore(context).getCredentialKey(
      scheme,
    );
    context.state.set(key, {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'cached-token'}},
    });

    const handler = new ToolAuthHandler(context, scheme, undefined, {
      credentialExchanger: passThroughExchanger(),
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe('cached-token');
  });

  it('should store the auth response credential in state and record it in the delta', async () => {
    const scheme: AuthScheme = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, scheme);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    // Stored via the State API so it is readable back through State.get...
    const key = await new ToolContextCredentialStore(
      mockContext,
    ).getCredentialKey(scheme);
    expect(state.get<AuthCredential>(key)?.apiKey).toBe('key');
    // ...and recorded in the delta so it is persisted to the session (rather
    // than being re-requested on every subsequent tool call).
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
      {credentialExchanger: passThroughExchanger()},
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.apiKey).toBe('static-key');
    // It is readable from the tool on every invocation, so persisting it would
    // only write the secret into the session store for nothing.
    expect(state.get('apiKey_existing_exchanged_credential')).toBeUndefined();
    expect(state.hasDelta()).toBe(false);
  });

  it('caches a static credential that did require an exchange', async () => {
    const scheme: AuthScheme = {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    };
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      scheme,
      credential,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    // An exchange costs a round trip, so its result is worth persisting.
    const stored = state.get<{http?: {credentials: {token: string}}}>(
      await new ToolContextCredentialStore(mockContext).getCredentialKey(
        scheme,
        credential,
      ),
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
  });

  it('qualifies the cached slot, and leaves the unqualified one alone', async () => {
    const scheme: AuthScheme = {type: 'http', scheme: 'bearer'};
    const store = new ToolContextCredentialStore(createContext());
    const context = createContext({
      // What the client answered a credential request with.
      'temp:jira_service_identity': {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      },
    });

    await new ToolAuthHandler(context, scheme, undefined, {
      credentialKey: 'jira_service_identity',
    }).prepareAuthCredentials();

    // Two tools can share a scheme type and still speak for different
    // identities, so the derived key keeps their slots apart.
    const stored = context.state.get<AuthCredential>(
      await store.getCredentialKey(scheme),
    );
    expect(stored?.apiKey).toBe('key');
    expect(
      context.state.get(store.getLegacyCredentialKey(scheme)),
    ).toBeUndefined();
  });

  it('reads back a credential cached under the qualified slot', async () => {
    // The cached credential needs no exchange, so it reaches the caller as it
    // was stored.
    const scheme: AuthScheme = {type: 'http', scheme: 'bearer'};
    const store = new ToolContextCredentialStore(createContext());
    const context = createContext({
      [await store.getCredentialKey(scheme)]: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'user-token'}},
      },
    });

    const result = await new ToolAuthHandler(context, scheme, undefined, {
      credentialKey: 'jira',
      credentialExchanger: passThroughExchanger(),
    }).prepareAuthCredentials();

    expect(result.authCredential?.http?.credentials.token).toBe('user-token');
  });

  it('reads back a credential cached under the unqualified slot', async () => {
    const scheme: AuthScheme = {type: 'http', scheme: 'bearer'};
    const store = new ToolContextCredentialStore(createContext());
    const context = createContext({
      [store.getLegacyCredentialKey(scheme)]: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'user-token'}},
      },
    });

    const result = await new ToolAuthHandler(context, scheme, undefined, {
      credentialExchanger: passThroughExchanger(),
    }).prepareAuthCredentials();

    // A credential cached by an earlier release is still read back.
    expect(result.authCredential?.http?.credentials.token).toBe('user-token');
  });
});

describe('ToolAuthHandler credential lifecycle', () => {
  it('returns pending with the scheme and the raw credential', async () => {
    const context = createContext();
    const exchanger = recordingExchanger(EXCHANGED_CREDENTIAL);

    const result = await new ToolAuthHandler(
      context,
      OIDC_SCHEME,
      OIDC_CREDENTIAL,
      {credentialExchanger: exchanger},
    ).prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(result.authScheme).toEqual(OIDC_SCHEME);
    expect(result.authCredential).toEqual(OIDC_CREDENTIAL);
    expect(exchanger.exchange).not.toHaveBeenCalled();
  });

  it('requests the credential under the key the caller named', async () => {
    const context = createContext();

    await new ToolAuthHandler(context, OIDC_SCHEME, OIDC_CREDENTIAL, {
      credentialKey: 'my_tool_tokens',
      credentialExchanger: recordingExchanger(EXCHANGED_CREDENTIAL),
    }).prepareAuthCredentials();

    expect(requestedKey(context)).toBe('my_tool_tokens');
  });

  it('gives two OAuth2 apps different auth request slots', async () => {
    const first = createContext();
    const second = createContext();
    const otherCredential = oidcCredential({clientId: 'other-client-id'});

    await new ToolAuthHandler(first, OIDC_SCHEME, OIDC_CREDENTIAL, {
      credentialExchanger: recordingExchanger(EXCHANGED_CREDENTIAL),
    }).prepareAuthCredentials();
    await new ToolAuthHandler(second, OIDC_SCHEME, otherCredential, {
      credentialExchanger: recordingExchanger(EXCHANGED_CREDENTIAL),
    }).prepareAuthCredentials();

    expect(requestedKey(first)).toMatch(/^adk_openIdConnect_/);
    expect(requestedKey(first)).not.toBe(requestedKey(second));
  });

  it('stores the auth response credential before exchanging it', async () => {
    const authResponse = oidcCredential({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    const context = createContext({'temp:tool_tokens': authResponse});
    const getAuthResponse = vi.spyOn(context, 'getAuthResponse');
    const exchanger = recordingExchanger(EXCHANGED_CREDENTIAL);

    const result = await new ToolAuthHandler(
      context,
      OIDC_SCHEME,
      OIDC_CREDENTIAL,
      {credentialKey: 'tool_tokens', credentialExchanger: exchanger},
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authScheme).toEqual(OIDC_SCHEME);
    expect(result.authCredential).toBe(EXCHANGED_CREDENTIAL);
    expect(getAuthResponse).toHaveBeenCalledTimes(1);
    // The stored credential carries the refresh token, which the exchanged
    // one does not, so a later invocation can still refresh.
    const stored = await storedCredential(context, OIDC_CREDENTIAL);
    expect(stored).toEqual(authResponse);
  });

  it('reuses a stored credential without consulting the auth response', async () => {
    const stored = oidcCredential({accessToken: 'stored-token'});
    const context = createContext(
      await seededStore(OIDC_CREDENTIAL, stored, OIDC_SCHEME),
    );
    const getAuthResponse = vi.spyOn(context, 'getAuthResponse');
    const exchanger = recordingExchanger(EXCHANGED_CREDENTIAL);

    const result = await new ToolAuthHandler(
      context,
      OIDC_SCHEME,
      OIDC_CREDENTIAL,
      {credentialExchanger: exchanger},
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(exchanger.exchange).toHaveBeenCalledWith({
      authScheme: OIDC_SCHEME,
      authCredential: stored,
    });
  });

  it('refreshes an expired stored credential', async () => {
    const stored = oidcCredential({
      accessToken: 'stale-token',
      refreshToken: 'old_refresh_token',
      expiresAt: 1,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      tokenResponse({
        access_token: 'new_access_token',
        refresh_token: 'new_refresh_token',
        expires_in: 3600,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const context = createContext(
      await seededStore(OIDC_CREDENTIAL, stored, OIDC_SCHEME),
    );
    // The real exchanger hands back a credential that already has a token.
    const exchanger = passThroughExchanger();

    const result = await new ToolAuthHandler(
      context,
      OIDC_SCHEME,
      OIDC_CREDENTIAL,
      {credentialExchanger: exchanger},
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe('https://provider.example.com/token');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old_refresh_token');
    // The refreshed credential, not the stale one, reaches the exchanger.
    const exchanged = exchanger.exchange.mock.calls[0][0] as {
      authCredential: AuthCredential;
    };
    expect(exchanged.authCredential.oauth2?.accessToken).toBe(
      'new_access_token',
    );
  });

  it('persists the refreshed credential to the store', async () => {
    const stored = oidcCredential({
      accessToken: 'stale-token',
      refreshToken: 'old_refresh_token',
      expiresAt: 1,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        tokenResponse({
          access_token: 'new_access_token',
          refresh_token: 'new_refresh_token',
          expires_in: 3600,
        }),
      ),
    );
    const context = createContext(
      await seededStore(OIDC_CREDENTIAL, stored, OIDC_SCHEME),
    );

    await new ToolAuthHandler(context, OIDC_SCHEME, OIDC_CREDENTIAL, {
      credentialExchanger: passThroughExchanger(),
    }).prepareAuthCredentials();

    // A provider that rotates its refresh token invalidates the stored one,
    // so the refreshed credential has to replace it.
    const persisted = await storedCredential(context, OIDC_CREDENTIAL);
    expect(persisted?.oauth2).toMatchObject({
      accessToken: 'new_access_token',
      refreshToken: 'new_refresh_token',
    });
  });

  it('does not refresh a stored credential that is still valid', async () => {
    const stored = oidcCredential({accessToken: 'stored-token'});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const context = createContext(
      await seededStore(OIDC_CREDENTIAL, stored, OIDC_SCHEME),
    );

    await new ToolAuthHandler(context, OIDC_SCHEME, OIDC_CREDENTIAL, {
      credentialExchanger: passThroughExchanger(),
    }).prepareAuthCredentials();

    // Preparing a cached, unexpired credential costs no network call and no
    // state write.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedCredential(context, OIDC_CREDENTIAL)).toEqual(stored);
    expect(context.state.hasDelta()).toBe(false);
  });
});

describe('ToolAuthHandler failed exchange', () => {
  const EXCHANGE_ERROR = new Error('metadata server unreachable');

  /** An exchanger that fails the way an unreachable token endpoint does. */
  function failingExchanger() {
    return {exchange: vi.fn().mockRejectedValue(EXCHANGE_ERROR)};
  }

  it('degrades to an unauthenticated call when the exchange throws', async () => {
    const context = createContext();

    const result = await new ToolAuthHandler(
      context,
      API_KEY_SCHEME,
      API_KEY_CREDENTIAL,
      {credentialExchanger: failingExchanger()},
    ).prepareAuthCredentials();

    // The tool calls the API unauthenticated and reports the API's own
    // rejection, rather than aborting the whole invocation.
    expect(result.state).toBe('done');
    expect(result.authScheme).toEqual(API_KEY_SCHEME);
    expect(result.authCredential).toBeUndefined();
  });

  it('logs the exchange failure without the credential or the key', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const context = createContext();

    await new ToolAuthHandler(
      context,
      OIDC_SCHEME,
      oidcCredential({accessToken: 'access-token'}),
      {
        credentialExchanger: failingExchanger(),
        credentialStore: new FakeCredentialStore(),
      },
    ).prepareAuthCredentials();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain('Failed to exchange credential');
    expect(message).toContain('metadata server unreachable');
    expect(message).not.toContain('client-secret');
    expect(message).not.toContain(FakeCredentialStore.KEY);
  });

  it('keeps the auth response credential stored when the exchange throws', async () => {
    const authResponse = oidcCredential({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    const context = createContext({'temp:tool_tokens': authResponse});

    await new ToolAuthHandler(context, OIDC_SCHEME, OIDC_CREDENTIAL, {
      credentialKey: 'tool_tokens',
      credentialExchanger: failingExchanger(),
    }).prepareAuthCredentials();

    // The refresh token only lives on the credential the client supplied, so
    // a failed exchange must not roll that write back.
    expect(await storedCredential(context, OIDC_CREDENTIAL)).toEqual(
      authResponse,
    );
  });

  it('stores nothing when the exchange throws on a static credential', async () => {
    const context = createContext();

    await new ToolAuthHandler(context, API_KEY_SCHEME, API_KEY_CREDENTIAL, {
      credentialExchanger: failingExchanger(),
    }).prepareAuthCredentials();

    expect(context.state.hasDelta()).toBe(false);
  });
});

describe('ToolAuthHandler credential copy', () => {
  it('works from the credential as it was at construction', async () => {
    const oauth2: OAuth2Auth = {
      clientId: 'client-id',
      clientSecret: 'client-secret',
    };
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2,
    };
    const beforeContext = createContext();
    const afterContext = createContext();

    const handler = new ToolAuthHandler(beforeContext, OIDC_SCHEME, credential);
    oauth2.clientId = 'mutated-client-id';
    const result = await handler.prepareAuthCredentials();
    await new ToolAuthHandler(
      afterContext,
      OIDC_SCHEME,
      credential,
    ).prepareAuthCredentials();

    expect(result.authCredential?.oauth2?.clientId).toBe('client-id');
    // The storage key is derived from the credential, so a mutation after
    // construction must not re-point the handler at another slot.
    expect(requestedKey(beforeContext)).not.toBe(requestedKey(afterContext));
  });

  it('shields the caller from an exchanger that writes back', async () => {
    const context = createContext();
    const scheme: AuthScheme = {...API_KEY_SCHEME};
    const credential: AuthCredential = {...API_KEY_CREDENTIAL};
    const schemeSnapshot = structuredClone(scheme);
    const credentialSnapshot = structuredClone(credential);
    const exchanger = {
      exchange: vi
        .fn()
        .mockImplementation(
          async (params: {
            authScheme: AuthScheme;
            authCredential: AuthCredential;
          }) => {
            params.authCredential.apiKey = 'exchanged-api-key';
            if (params.authScheme.type === 'apiKey') {
              params.authScheme.name = 'X-Exchanged-Key';
            }
            return {credential: params.authCredential, wasExchanged: true};
          },
        ),
    };

    await new ToolAuthHandler(context, scheme, credential, {
      credentialExchanger: exchanger,
    }).prepareAuthCredentials();

    expect(scheme).toEqual(schemeSnapshot);
    expect(credential).toEqual(credentialSnapshot);
  });
});

describe('ToolAuthHandler external exchange', () => {
  const AUTHORIZATION_CODE_SCHEME: AuthScheme = {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://provider.example.com/authorize',
        tokenUrl: 'https://provider.example.com/token',
        scopes: {},
      },
    },
  };
  const CLIENT_CREDENTIALS_SCHEME: AuthScheme = {
    type: 'oauth2',
    flows: {
      clientCredentials: {
        tokenUrl: 'https://provider.example.com/token',
        scopes: {},
      },
    },
  };
  const TOKENLESS_CREDENTIAL: AuthCredential = {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
  };

  it('consults the auth response for a token-less credential', async () => {
    const context = createContext(
      await seededStore(
        TOKENLESS_CREDENTIAL,
        TOKENLESS_CREDENTIAL,
        AUTHORIZATION_CODE_SCHEME,
      ),
    );
    const getAuthResponse = vi.spyOn(context, 'getAuthResponse');

    await new ToolAuthHandler(
      context,
      AUTHORIZATION_CODE_SCHEME,
      TOKENLESS_CREDENTIAL,
      {credentialExchanger: recordingExchanger(EXCHANGED_CREDENTIAL)},
    ).prepareAuthCredentials();

    expect(getAuthResponse).toHaveBeenCalledTimes(1);
  });

  it('exchanges a client credentials grant without asking the client', async () => {
    const context = createContext(
      await seededStore(
        TOKENLESS_CREDENTIAL,
        TOKENLESS_CREDENTIAL,
        CLIENT_CREDENTIALS_SCHEME,
      ),
    );
    const getAuthResponse = vi.spyOn(context, 'getAuthResponse');
    const exchanger = recordingExchanger(EXCHANGED_CREDENTIAL);

    const result = await new ToolAuthHandler(
      context,
      CLIENT_CREDENTIALS_SCHEME,
      TOKENLESS_CREDENTIAL,
      {credentialExchanger: exchanger},
    ).prepareAuthCredentials();

    // A machine-to-machine grant has no user to consent, so routing it to the
    // client would strand the tool in `pending`.
    expect(result.state).toBe('done');
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(exchanger.exchange).toHaveBeenCalledTimes(1);
  });
});

describe('ToolAuthHandler credential validation', () => {
  it('rejects an OIDC scheme with no oauth2 credential', async () => {
    const context = createContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    await expect(
      new ToolAuthHandler(context, OIDC_SCHEME, {
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      }).prepareAuthCredentials(),
    ).rejects.toThrow(/auth credential is empty for scheme openIdConnect/);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('rejects a credential with no clientId', async () => {
    const context = createContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    await expect(
      new ToolAuthHandler(
        context,
        OIDC_SCHEME,
        oidcCredential({clientId: undefined}),
      ).prepareAuthCredentials(),
    ).rejects.toThrow(AuthCredentialMissingError);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('rejects a credential with no clientSecret', async () => {
    const context = createContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    await expect(
      new ToolAuthHandler(
        context,
        OIDC_SCHEME,
        oidcCredential({clientSecret: undefined}),
      ).prepareAuthCredentials(),
    ).rejects.toThrow('OAuth2 credentials clientSecret is missing.');
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('requests a credential for an apiKey scheme without validating it', async () => {
    const context = createContext();

    const result = await new ToolAuthHandler(
      context,
      API_KEY_SCHEME,
    ).prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(result.authScheme).toEqual(API_KEY_SCHEME);
    expect(requestedKey(context)).toMatch(/^adk_apiKey_/);
  });
});

describe('ToolAuthHandler injection', () => {
  it('reads and writes through an injected store', async () => {
    const context = createContext({'temp:tool_tokens': API_KEY_CREDENTIAL});
    const store = new FakeCredentialStore();

    await new ToolAuthHandler(context, API_KEY_SCHEME, undefined, {
      credentialKey: 'tool_tokens',
      credentialStore: store,
      credentialExchanger: recordingExchanger(EXCHANGED_CREDENTIAL),
    }).prepareAuthCredentials();

    expect(store.getCredentialCalls).toBe(1);
    expect(store.entries.get(FakeCredentialStore.KEY)).toEqual(
      API_KEY_CREDENTIAL,
    );
    // The injected store replaces the session state entirely.
    expect(context.state.hasDelta()).toBe(false);
  });

  it('serves a credential the injected store already holds', async () => {
    const stored = oidcCredential({accessToken: 'injected-token'});
    const store = new FakeCredentialStore();
    store.entries.set(FakeCredentialStore.KEY, stored);
    const exchanger = recordingExchanger(EXCHANGED_CREDENTIAL);

    const result = await new ToolAuthHandler(
      createContext(),
      OIDC_SCHEME,
      OIDC_CREDENTIAL,
      {credentialStore: store, credentialExchanger: exchanger},
    ).prepareAuthCredentials();

    expect(result.authCredential).toBe(EXCHANGED_CREDENTIAL);
    expect(exchanger.exchange).toHaveBeenCalledWith({
      authScheme: OIDC_SCHEME,
      authCredential: stored,
    });
  });
});

describe('ToolContextCredentialStore', () => {
  it('keys two credentials that differ only in redirectUri the same', async () => {
    const store = new ToolContextCredentialStore(createContext());

    expect(
      await store.getCredentialKey(
        OIDC_SCHEME,
        oidcCredential({redirectUri: 'https://one.example.com/callback'}),
      ),
    ).toBe(
      await store.getCredentialKey(
        OIDC_SCHEME,
        oidcCredential({redirectUri: 'https://two.example.com/callback'}),
      ),
    );
  });

  it('keys the legacy slot the same across a redirectUri change', async () => {
    const store = new ToolContextCredentialStore(createContext());

    expect(store.getLegacyCredentialKey(OIDC_SCHEME)).toBe(
      store.getLegacyCredentialKey({...OIDC_SCHEME}),
    );
  });

  it('names a default legacy slot when there is no scheme', () => {
    const store = new ToolContextCredentialStore(createContext());

    expect(store.getLegacyCredentialKey()).toBe(
      'default_existing_exchanged_credential',
    );
  });

  it('migrates a credential held under the legacy key', async () => {
    const cached = oidcCredential({accessToken: 'legacy-token'});
    const context = createContext();
    const store = new ToolContextCredentialStore(context);
    const legacyKey = store.getLegacyCredentialKey(OIDC_SCHEME);
    const key = await store.getCredentialKey(OIDC_SCHEME, OIDC_CREDENTIAL);
    context.state.set(legacyKey, cached);

    expect(legacyKey).not.toBe(key);
    expect(context.state.get(key)).toBeUndefined();
    expect(await store.getCredential(OIDC_SCHEME, OIDC_CREDENTIAL)).toEqual(
      cached,
    );
    expect(context.state.get(key)).toEqual(cached);
    // A rollback to an earlier release must still find the credential.
    expect(context.state.get(legacyKey)).toEqual(cached);
  });

  it('reports no credential when neither key holds one', async () => {
    const store = new ToolContextCredentialStore(createContext());

    expect(
      await store.getCredential(OIDC_SCHEME, OIDC_CREDENTIAL),
    ).toBeUndefined();
  });

  it('keeps two OAuth2 apps apart', async () => {
    const context = createContext();
    const store = new ToolContextCredentialStore(context);
    const otherCredential = oidcCredential({clientId: 'other-client-id'});
    const cached = oidcCredential({accessToken: 'first-app-token'});
    await store.storeCredential(
      await store.getCredentialKey(OIDC_SCHEME, OIDC_CREDENTIAL),
      cached,
    );

    expect(await store.getCredential(OIDC_SCHEME, OIDC_CREDENTIAL)).toEqual(
      cached,
    );
    expect(
      await store.getCredential(OIDC_SCHEME, otherCredential),
    ).toBeUndefined();
  });
});
