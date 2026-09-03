/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  BaseCredentialExchanger,
  Context,
  createSession,
  CredentialManager,
  ExchangeResult,
  InMemoryCredentialService,
  InvocationContext,
  OpenIdConnectWithConfig,
  PluginManager,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const TOKEN_URL = 'https://example.com/oauth2/token';
const AUTHORIZE_URL = 'https://example.com/oauth2/authorize';

const AUTHORIZATION_CODE_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: AUTHORIZE_URL,
      tokenUrl: TOKEN_URL,
      scopes: {read: 'Read access'},
    },
  },
};

const CLIENT_CREDENTIALS_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {clientCredentials: {tokenUrl: TOKEN_URL, scopes: {}}},
};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
};

const OAUTH2_CLIENT_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
};

function createToolContext(options?: {
  credentialService?: InMemoryCredentialService;
  userId?: string;
}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: options?.userId ?? 'user-1',
      }),
      pluginManager: new PluginManager([]),
      credentialService: options?.credentialService,
    }),
    functionCallId: 'call-1',
  });
}

/** An exchanger that hands back a fixed credential. */
class FakeExchanger implements BaseCredentialExchanger {
  calls = 0;

  constructor(
    private readonly result: AuthCredential,
    private readonly wasExchanged = true,
  ) {}

  async exchange(): Promise<ExchangeResult> {
    this.calls += 1;
    return {credential: this.result, wasExchanged: this.wasExchanged};
  }
}

function stubTokenEndpoint(accessToken: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
      {status: 200, headers: {'Content-Type': 'application/json'}},
    ),
  );
}

describe('CredentialManager validation', () => {
  it('requires a raw credential for an OAuth2 scheme', async () => {
    const manager = new CredentialManager({
      authScheme: AUTHORIZATION_CODE_SCHEME,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'raw_auth_credential is required for auth_scheme type oauth2',
    );
  });

  it('requires a raw credential for an OpenID Connect scheme', async () => {
    const manager = new CredentialManager({
      authScheme: {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
      },
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'raw_auth_credential is required for auth_scheme type openIdConnect',
    );
  });

  it('accepts a non-OAuth scheme with no raw credential', async () => {
    const manager = new CredentialManager({
      authScheme: API_KEY_SCHEME,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).resolves.toBeUndefined();
  });

  it('requires the oauth2 block on an OAuth2 credential', async () => {
    const manager = new CredentialManager({
      authScheme: API_KEY_SCHEME,
      rawAuthCredential: {authType: AuthCredentialTypes.OAUTH2},
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'auth_config.raw_credential.oauth2 required for credential type oauth2',
    );
  });

  it('rejects an OAuth2 scheme whose flow has no authorization URL', async () => {
    const manager = new CredentialManager({
      authScheme: {
        type: 'oauth2',
        flows: {implicit: {authorizationUrl: '', scopes: {}}},
      },
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'OAuth scheme info is missing, and auto-discovery has failed to fill them in.',
    );
  });

  it('rejects an OAuth2 scheme whose password flow has no token URL', async () => {
    const manager = new CredentialManager({
      authScheme: {
        type: 'oauth2',
        flows: {password: {tokenUrl: '', scopes: {}}},
      },
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow('OAuth scheme info is missing');
  });

  it('rejects a client-credentials flow with no token URL', async () => {
    const manager = new CredentialManager({
      authScheme: {
        type: 'oauth2',
        flows: {clientCredentials: {tokenUrl: '', scopes: {}}},
      },
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow('OAuth scheme info is missing');
  });

  it('rejects an authorization-code flow with no token URL', async () => {
    const manager = new CredentialManager({
      authScheme: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: AUTHORIZE_URL,
            tokenUrl: '',
            scopes: {},
          },
        },
      },
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow('OAuth scheme info is missing');
  });

  it('accepts an OAuth2 scheme that declares no flow', async () => {
    const manager = new CredentialManager({
      authScheme: {type: 'oauth2', flows: {}},
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).resolves.toBeUndefined();
  });
});

describe('CredentialManager ready credentials', () => {
  it('returns an API key credential as it stands', async () => {
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-key',
    };
    const manager = new CredentialManager({
      authScheme: API_KEY_SCHEME,
      rawAuthCredential,
      credentialKey: 'key',
    });

    const credential = await manager.getAuthCredential(createToolContext());

    expect(credential).toEqual(rawAuthCredential);
  });

  it('returns an HTTP credential as it stands', async () => {
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'token'}},
    };
    const manager = new CredentialManager({
      authScheme: API_KEY_SCHEME,
      rawAuthCredential,
      credentialKey: 'key',
    });

    const credential = await manager.getAuthCredential(createToolContext());

    expect(credential).toEqual(rawAuthCredential);
  });

  it('returns a copy, so the caller cannot mutate the shared config', async () => {
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'original'}},
    };
    const manager = new CredentialManager({
      authScheme: API_KEY_SCHEME,
      rawAuthCredential,
      credentialKey: 'key',
    });

    const credential = await manager.getAuthCredential(createToolContext());
    expect(credential?.http?.credentials).toBeDefined();
    credential!.http!.credentials!.token = 'mutated';

    expect(rawAuthCredential.http?.credentials?.token).toBe('original');
  });
});

describe('CredentialManager stored credentials', () => {
  it('loads a stored credential from the credential service', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    const authConfig: AuthConfig = {
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'stored_key',
    };
    const stored: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'stored-token', expiresAt: Date.now() + 3_600_000},
    };
    await credentialService.saveCredential(
      {...authConfig, exchangedAuthCredential: stored},
      context,
    );

    const credential = await new CredentialManager(
      authConfig,
    ).getAuthCredential(context);

    expect(credential?.oauth2?.accessToken).toBe('stored-token');
  });

  it('resolves to undefined when nothing is stored and no response arrived', async () => {
    const manager = new CredentialManager({
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    const credential = await manager.getAuthCredential(
      createToolContext({credentialService: new InMemoryCredentialService()}),
    );

    expect(credential).toBeUndefined();
  });

  it('resolves to undefined when no credential service is configured', async () => {
    const manager = new CredentialManager({
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    const credential = await manager.getAuthCredential(createToolContext());

    expect(credential).toBeUndefined();
  });

  it('never reads or writes the store for a service account credential', async () => {
    const credentialService = new InMemoryCredentialService();
    const loadSpy = vi.spyOn(credentialService, 'loadCredential');
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');
    const exchanged: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'sa-access-token'}},
    };
    const manager = new CredentialManager({
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential: {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      },
      credentialKey: 'key',
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      new FakeExchanger(exchanged),
    );

    const credential = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(credential).toEqual(exchanged);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe('CredentialManager auth response', () => {
  it('takes the credential the client returned and stores it', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      credentialKey: 'response_key',
    };
    const fromClient: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'client-supplied',
    };
    context.state.set('temp:response_key', fromClient);

    const credential = await new CredentialManager(
      authConfig,
    ).getAuthCredential(context);

    expect(credential).toEqual(fromClient);
    expect(await credentialService.loadCredential(authConfig, context)).toEqual(
      fromClient,
    );
  });

  it('saves a copy, leaving the manager config untouched', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      credentialKey: 'copy_key',
    };
    context.state.set('temp:copy_key', {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'client-supplied',
    });
    const saveSpy = vi.spyOn(credentialService, 'saveCredential');

    await new CredentialManager(authConfig).getAuthCredential(context);

    expect(authConfig.exchangedAuthCredential).toBeUndefined();
    const [savedConfig] = saveSpy.mock.calls[0];
    expect(savedConfig).not.toBe(authConfig);
    expect(savedConfig.exchangedAuthCredential?.apiKey).toBe('client-supplied');
  });

  it('does not write to a store that is not configured', async () => {
    const context = createToolContext();
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      credentialKey: 'no_store_key',
    };
    const fromClient: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'client-supplied',
    };
    context.state.set('temp:no_store_key', fromClient);

    const credential = await new CredentialManager(
      authConfig,
    ).getAuthCredential(context);

    expect(credential).toEqual(fromClient);
  });
});

describe('CredentialManager client credentials flow', () => {
  it('uses the raw credential when the OAuth2 scheme declares the flow', async () => {
    const exchanged: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'minted-token'},
    };
    const exchanger = new FakeExchanger(exchanged);
    const manager = new CredentialManager({
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);

    const credential = await manager.getAuthCredential(createToolContext());

    expect(credential).toEqual(exchanged);
    expect(exchanger.calls).toBe(1);
  });

  it('does not use the raw credential for an authorization-code scheme', async () => {
    const exchanger = new FakeExchanger({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'minted-token'},
    });
    const manager = new CredentialManager({
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);

    const credential = await manager.getAuthCredential(createToolContext());

    expect(credential).toBeUndefined();
    expect(exchanger.calls).toBe(0);
  });

  it('uses the raw credential when an OIDC scheme supports the grant type', async () => {
    const oidcScheme: OpenIdConnectWithConfig = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      authorizationEndpoint: AUTHORIZE_URL,
      tokenEndpoint: TOKEN_URL,
      grantTypesSupported: ['client_credentials'],
    };
    const exchanged: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'oidc-token'},
    };
    const manager = new CredentialManager({
      authScheme: oidcScheme,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.OAUTH2,
      new FakeExchanger(exchanged),
    );

    const credential = await manager.getAuthCredential(createToolContext());

    expect(credential).toEqual(exchanged);
  });

  it('does not use the raw credential when the OIDC scheme omits the grant type', async () => {
    const oidcScheme: OpenIdConnectWithConfig = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      authorizationEndpoint: AUTHORIZE_URL,
      tokenEndpoint: TOKEN_URL,
      grantTypesSupported: ['authorization_code'],
    };
    const manager = new CredentialManager({
      authScheme: oidcScheme,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).resolves.toBeUndefined();
  });

  it('does not use the raw credential for a plain OIDC scheme', async () => {
    const manager = new CredentialManager({
      authScheme: {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
      },
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).resolves.toBeUndefined();
  });

  it('does not use the raw credential when the grant type list is absent', async () => {
    const oidcScheme: OpenIdConnectWithConfig = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      authorizationEndpoint: AUTHORIZE_URL,
      tokenEndpoint: TOKEN_URL,
      grantTypesSupported: undefined,
    };
    const manager = new CredentialManager({
      authScheme: oidcScheme,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).resolves.toBeUndefined();
  });

  it('copies the raw credential before the exchange step mutates it', async () => {
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };
    const manager = new CredentialManager({
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential,
      credentialKey: 'key',
    });
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, {
      async exchange({authCredential}) {
        authCredential.oauth2!.accessToken = 'minted-token';
        return {credential: authCredential, wasExchanged: true};
      },
    });

    const credential = await manager.getAuthCredential(createToolContext());

    expect(credential?.oauth2?.accessToken).toBe('minted-token');
    expect(rawAuthCredential.oauth2?.accessToken).toBeUndefined();
  });
});

describe('CredentialManager exchange and refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the refresh when the credential was exchanged', async () => {
    const fetchSpy = stubTokenEndpoint('should-not-be-used');
    const exchanged: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        accessToken: 'minted-token',
        refreshToken: 'refresh-token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        expiresAt: Date.now() - 3_600_000,
      },
    };
    const manager = new CredentialManager({
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'key',
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.OAUTH2,
      new FakeExchanger(exchanged),
    );

    const credential = await manager.getAuthCredential(createToolContext());

    expect(credential).toEqual(exchanged);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes an expired stored credential and stores the new one', async () => {
    const fetchSpy = stubTokenEndpoint('refreshed-token');
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    const authConfig: AuthConfig = {
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'refresh_key',
    };
    await credentialService.saveCredential(
      {
        ...authConfig,
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            accessToken: 'expired-token',
            refreshToken: 'refresh-token',
            clientId: 'client-id',
            clientSecret: 'client-secret',
            expiresAt: Date.now() - 3_600_000,
          },
        },
      },
      context,
    );

    const credential = await new CredentialManager(
      authConfig,
    ).getAuthCredential(context);

    expect(credential?.oauth2?.accessToken).toBe('refreshed-token');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const stored = await credentialService.loadCredential(authConfig, context);
    expect(stored?.oauth2?.accessToken).toBe('refreshed-token');
  });

  it('leaves a credential alone when no exchanger or refresher is registered', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      credentialKey: 'plain_key',
    };
    const fromClient: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'client-supplied',
    };
    context.state.set('temp:plain_key', fromClient);

    const credential = await new CredentialManager(
      authConfig,
    ).getAuthCredential(context);

    expect(credential).toEqual(fromClient);
  });

  it('keeps a stored credential that does not need a refresh', async () => {
    const fetchSpy = stubTokenEndpoint('should-not-be-used');
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    const authConfig: AuthConfig = {
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'fresh_key',
    };
    await credentialService.saveCredential(
      {
        ...authConfig,
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            accessToken: 'fresh-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 3_600_000,
          },
        },
      },
      context,
    );

    const credential = await new CredentialManager(
      authConfig,
    ).getAuthCredential(context);

    expect(credential?.oauth2?.accessToken).toBe('fresh-token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('CredentialManager.requestCredential', () => {
  it('records the request on the tool context', async () => {
    const context = createToolContext();
    const authConfig: AuthConfig = {
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'request_key',
    };

    await new CredentialManager(authConfig).requestCredential(context);

    const requested = context.eventActions.requestedAuthConfigs['call-1'];
    expect(requested.credentialKey).toBe('request_key');
  });

  it('does not leak one user credential into another user request', async () => {
    const authConfig: AuthConfig = {
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_CLIENT_CREDENTIAL,
      credentialKey: 'shared_key',
    };
    const manager = new CredentialManager(authConfig);
    const contextA = createToolContext({userId: 'user-a'});
    const contextB = createToolContext({userId: 'user-b'});
    contextA.state.set('temp:shared_key', {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        authUri: `${AUTHORIZE_URL}?x=y`,
        state: 'state-a',
        accessToken: 'token-a',
        expiresAt: Date.now() + 3_600_000,
      },
    });

    await manager.getAuthCredential(contextA);
    await manager.requestCredential(contextB);

    const requested = contextB.eventActions.requestedAuthConfigs['call-1'];
    expect(
      requested.exchangedAuthCredential?.oauth2?.accessToken,
    ).toBeUndefined();
  });
});
