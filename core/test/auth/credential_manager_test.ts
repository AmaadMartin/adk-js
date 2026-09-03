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
  BaseCredentialService,
  Context,
  CredentialManager,
  ExchangeResult,
  InMemoryCredentialService,
  InvocationContext,
  LlmAgent,
  OAuth2CredentialExchanger,
  OpenIdConnectWithConfig,
  PluginManager,
  createSession,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, assert, describe, expect, it, vi} from 'vitest';
import {OAuth2CredentialRefresher} from '../../src/auth/oauth2/oauth2_credential_refresher.js';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const AUTH_CODE_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://provider.example.com/authorize',
      tokenUrl: 'https://provider.example.com/token',
      scopes: {read: 'Read everything'},
    },
  },
};

const CLIENT_CREDENTIALS_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    clientCredentials: {
      tokenUrl: 'https://provider.example.com/token',
      scopes: {read: 'Read everything'},
    },
  },
};

const RAW_OAUTH2_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
};

function makeCredentialService(stored?: AuthCredential) {
  return {
    loadCredential: vi.fn(async () => stored),
    saveCredential: vi.fn(async (_authConfig: AuthConfig) => {}),
  } satisfies BaseCredentialService;
}

function makeContext(options?: {
  credentialService?: BaseCredentialService;
  state?: Record<string, unknown>;
  functionCallId?: string;
}): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    // A real agent instance, so the fixture breaks if InvocationContext's
    // contract changes rather than being silenced by a cast.
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session: createSession({
      id: 's1',
      appName: 'app',
      userId: 'u1',
      state: options?.state,
    }),
    pluginManager: new PluginManager([]),
    credentialService: options?.credentialService,
  });
  return new Context({
    invocationContext,
    functionCallId: options?.functionCallId,
  });
}

/** An auth response the client has already sent back, as the state holds it. */
function authResponseState(
  credentialKey: string,
  credential: AuthCredential,
): Record<string, unknown> {
  return {[`temp:${credentialKey}`]: credential};
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CredentialManager validation', () => {
  it.each(['oauth2', 'openIdConnect'])(
    'rejects a %s scheme with no raw credential',
    async (type) => {
      const authScheme =
        type === 'oauth2'
          ? AUTH_CODE_SCHEME
          : ({
              type: 'openIdConnect',
              openIdConnectUrl: 'https://provider.example.com/.well-known',
            } satisfies AuthScheme);
      const manager = new CredentialManager({credentialKey: 'k', authScheme});

      await expect(manager.getAuthCredential(makeContext())).rejects.toThrow(
        `rawAuthCredential is required for auth scheme type ${type}`,
      );
    },
  );

  it.each([AuthCredentialTypes.OAUTH2, AuthCredentialTypes.OPEN_ID_CONNECT])(
    'rejects a %s credential with no oauth2 block',
    async (authType) => {
      const manager = new CredentialManager({
        credentialKey: 'k',
        authScheme: AUTH_CODE_SCHEME,
        rawAuthCredential: {authType},
      });

      await expect(manager.getAuthCredential(makeContext())).rejects.toThrow(
        `authConfig.rawAuthCredential.oauth2 is required for credential type ${authType}`,
      );
    },
  );

  const incompleteFlows: Array<
    [string, OpenAPIV3.OAuth2SecurityScheme['flows']]
  > = [
    [
      'flows.implicit.authorizationUrl',
      {implicit: {authorizationUrl: '', scopes: {}}},
    ],
    ['flows.password.tokenUrl', {password: {tokenUrl: '', scopes: {}}}],
    [
      'flows.clientCredentials.tokenUrl',
      {clientCredentials: {tokenUrl: '', scopes: {}}},
    ],
    [
      'flows.authorizationCode.authorizationUrl',
      {authorizationCode: {authorizationUrl: '', tokenUrl: 't', scopes: {}}},
    ],
    [
      'flows.authorizationCode.tokenUrl',
      {authorizationCode: {authorizationUrl: 'a', tokenUrl: '', scopes: {}}},
    ],
  ];

  it.each(incompleteFlows)('names the missing %s', async (field, flows) => {
    const manager = new CredentialManager({
      credentialKey: 'k',
      authScheme: {type: 'oauth2', flows},
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    });

    await expect(manager.getAuthCredential(makeContext())).rejects.toThrow(
      `authConfig.authScheme.${field} is required for the declared OAuth2 flow`,
    );
  });

  it('accepts a complete OAuth2 scheme', async () => {
    const manager = new CredentialManager({
      credentialKey: 'k',
      authScheme: AUTH_CODE_SCHEME,
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    });

    await expect(
      manager.getAuthCredential(makeContext()),
    ).resolves.toBeUndefined();
  });
});

describe('CredentialManager ready credentials', () => {
  it.each([
    [
      AuthCredentialTypes.API_KEY,
      {authType: AuthCredentialTypes.API_KEY, apiKey: 'secret'},
    ],
    [
      AuthCredentialTypes.HTTP,
      {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'secret'}},
      },
    ],
  ] satisfies Array<[AuthCredentialTypes, AuthCredential]>)(
    'returns a %s credential without touching the credential service',
    async (_authType, rawAuthCredential) => {
      const credentialService = makeCredentialService();
      const manager = new CredentialManager({
        credentialKey: 'k',
        authScheme: API_KEY_SCHEME,
        rawAuthCredential,
      });

      const credential = await manager.getAuthCredential(
        makeContext({credentialService}),
      );

      expect(credential).toEqual(rawAuthCredential);
      expect(credentialService.loadCredential).not.toHaveBeenCalled();
    },
  );

  it('returns a copy, so a caller cannot mutate the shared config', async () => {
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret',
    };
    const manager = new CredentialManager({
      credentialKey: 'k',
      authScheme: API_KEY_SCHEME,
      rawAuthCredential,
    });

    const credential = await manager.getAuthCredential(makeContext());
    assert(credential);
    credential.apiKey = 'tampered';

    expect(rawAuthCredential.apiKey).toBe('secret');
  });
});

describe('CredentialManager credential sources', () => {
  const storedCredential: AuthCredential = {
    authType: AuthCredentialTypes.HTTP,
    http: {scheme: 'bearer', credentials: {token: 'stored'}},
  };

  it('loads from the credential service and ignores the auth response', async () => {
    const credentialService = makeCredentialService(storedCredential);
    const otherCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'from-auth-response',
    };
    const manager = new CredentialManager({
      credentialKey: 'k',
      authScheme: API_KEY_SCHEME,
    });

    const credential = await manager.getAuthCredential(
      makeContext({
        credentialService,
        state: authResponseState('k', otherCredential),
      }),
    );

    expect(credential).toEqual(storedCredential);
    expect(credentialService.saveCredential).not.toHaveBeenCalled();
  });

  it('falls back to the auth response and saves it', async () => {
    const credentialService = makeCredentialService();
    const fromClient: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'from-auth-response',
    };
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: API_KEY_SCHEME,
    };

    const credential = await new CredentialManager(
      authConfig,
    ).getAuthCredential(
      makeContext({
        credentialService,
        state: authResponseState('k', fromClient),
      }),
    );

    expect(credential).toEqual(fromClient);
    expect(credentialService.saveCredential).toHaveBeenCalledOnce();
    expect(credentialService.saveCredential.mock.calls[0][0]).toEqual({
      ...authConfig,
      exchangedAuthCredential: fromClient,
    });
  });

  it('returns nothing when the authorization code flow has nothing stored', async () => {
    const manager = new CredentialManager({
      credentialKey: 'k',
      authScheme: AUTH_CODE_SCHEME,
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    });

    await expect(
      manager.getAuthCredential(makeContext()),
    ).resolves.toBeUndefined();
  });

  it('uses the raw credential for a client credentials flow', async () => {
    const exchange = vi
      .spyOn(OAuth2CredentialExchanger.prototype, 'exchange')
      .mockResolvedValue({
        credential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {accessToken: 'app-token'},
        },
        wasExchanged: true,
      });
    const manager = new CredentialManager({
      credentialKey: 'k',
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    });

    const credential = await manager.getAuthCredential(makeContext());

    expect(credential?.oauth2?.accessToken).toBe('app-token');
    expect(exchange.mock.calls[0][0].authCredential).toEqual(
      RAW_OAUTH2_CREDENTIAL,
    );
    // The raw credential is copied before the exchanger sees it.
    expect(exchange.mock.calls[0][0].authCredential).not.toBe(
      RAW_OAUTH2_CREDENTIAL,
    );
  });

  it('uses the raw credential for an OIDC client credentials flow', async () => {
    vi.spyOn(OAuth2CredentialExchanger.prototype, 'exchange').mockResolvedValue(
      {
        credential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {accessToken: 'oidc-token'},
        },
        wasExchanged: true,
      },
    );
    const authScheme: OpenIdConnectWithConfig = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://provider.example.com/.well-known',
      authorizationEndpoint: 'https://provider.example.com/authorize',
      tokenEndpoint: 'https://provider.example.com/token',
      grantTypesSupported: ['client_credentials'],
    };

    const credential = await new CredentialManager({
      credentialKey: 'k',
      authScheme,
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    }).getAuthCredential(makeContext());

    expect(credential?.oauth2?.accessToken).toBe('oidc-token');
  });

  it('returns nothing for an OIDC scheme without the client credentials grant', async () => {
    const authScheme: OpenIdConnectWithConfig = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://provider.example.com/.well-known',
      authorizationEndpoint: 'https://provider.example.com/authorize',
      tokenEndpoint: 'https://provider.example.com/token',
      grantTypesSupported: ['authorization_code'],
    };

    await expect(
      new CredentialManager({
        credentialKey: 'k',
        authScheme,
        rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
      }).getAuthCredential(makeContext()),
    ).resolves.toBeUndefined();
  });
});

describe('CredentialManager exchange and refresh', () => {
  const oauth2FromClient: AuthCredential = {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: 'client-id', authCode: 'code'},
  };

  it('saves an exchanged credential', async () => {
    const exchanged: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'fresh'},
    };
    vi.spyOn(OAuth2CredentialExchanger.prototype, 'exchange').mockResolvedValue(
      {
        credential: exchanged,
        wasExchanged: true,
      },
    );
    const credentialService = makeCredentialService(oauth2FromClient);

    const credential = await new CredentialManager({
      credentialKey: 'k',
      authScheme: AUTH_CODE_SCHEME,
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    }).getAuthCredential(makeContext({credentialService}));

    expect(credential).toEqual(exchanged);
    expect(credentialService.saveCredential).toHaveBeenCalledOnce();
  });

  it('refreshes an expired credential and saves it', async () => {
    const refreshed: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'refreshed'},
    };
    vi.spyOn(OAuth2CredentialExchanger.prototype, 'exchange').mockResolvedValue(
      {
        credential: oauth2FromClient,
        wasExchanged: false,
      },
    );
    const refresh = vi
      .spyOn(OAuth2CredentialRefresher.prototype, 'refresh')
      .mockResolvedValue(refreshed);
    vi.spyOn(
      OAuth2CredentialRefresher.prototype,
      'isRefreshNeeded',
    ).mockResolvedValue(true);
    const credentialService = makeCredentialService(oauth2FromClient);

    const credential = await new CredentialManager({
      credentialKey: 'k',
      authScheme: AUTH_CODE_SCHEME,
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    }).getAuthCredential(makeContext({credentialService}));

    expect(credential).toEqual(refreshed);
    expect(refresh).toHaveBeenCalledOnce();
    expect(credentialService.saveCredential).toHaveBeenCalledOnce();
  });

  it('does not refresh after an exchange', async () => {
    vi.spyOn(OAuth2CredentialExchanger.prototype, 'exchange').mockResolvedValue(
      {
        credential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {accessToken: 'fresh'},
        },
        wasExchanged: true,
      },
    );
    const isRefreshNeeded = vi.spyOn(
      OAuth2CredentialRefresher.prototype,
      'isRefreshNeeded',
    );

    await new CredentialManager({
      credentialKey: 'k',
      authScheme: AUTH_CODE_SCHEME,
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    }).getAuthCredential(
      makeContext({credentialService: makeCredentialService(oauth2FromClient)}),
    );

    expect(isRefreshNeeded).not.toHaveBeenCalled();
  });

  it('leaves an unchanged credential unsaved', async () => {
    const stored: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'still-valid'},
    };
    const credentialService = makeCredentialService(stored);

    const credential = await new CredentialManager({
      credentialKey: 'k',
      authScheme: AUTH_CODE_SCHEME,
      rawAuthCredential: RAW_OAUTH2_CREDENTIAL,
    }).getAuthCredential(makeContext({credentialService}));

    expect(credential).toEqual(stored);
    expect(credentialService.saveCredential).not.toHaveBeenCalled();
  });

  it('works without a credential service', async () => {
    const fromClient: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'from-auth-response',
    };

    const credential = await new CredentialManager({
      credentialKey: 'k',
      authScheme: API_KEY_SCHEME,
    }).getAuthCredential(
      makeContext({state: authResponseState('k', fromClient)}),
    );

    expect(credential).toEqual(fromClient);
  });
});

describe('CredentialManager service account credentials', () => {
  const serviceAccountRaw: AuthCredential = {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: {useDefaultCredential: true},
  };

  it('asks the client when nothing is stored for it', async () => {
    const credentialService = makeCredentialService();

    const credential = await new CredentialManager({
      credentialKey: 'k',
      authScheme: API_KEY_SCHEME,
      rawAuthCredential: serviceAccountRaw,
    }).getAuthCredential(makeContext({credentialService}));

    expect(credential).toBeUndefined();
    expect(credentialService.loadCredential).not.toHaveBeenCalled();
  });

  it('propagates a service account exchange failure', async () => {
    const fromClient: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: false},
    };

    await expect(
      new CredentialManager({
        credentialKey: 'k',
        authScheme: API_KEY_SCHEME,
      }).getAuthCredential(
        makeContext({state: authResponseState('k', fromClient)}),
      ),
    ).rejects.toThrow('Service account credentials are missing.');
  });

  it('neither loads nor saves a service account credential', async () => {
    const credentialService = makeCredentialService();
    const fromClient: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'client-token'}},
    };

    const credential = await new CredentialManager({
      credentialKey: 'k',
      authScheme: API_KEY_SCHEME,
      rawAuthCredential: serviceAccountRaw,
    }).getAuthCredential(
      makeContext({
        credentialService,
        state: authResponseState('k', fromClient),
      }),
    );

    expect(credential).toEqual(fromClient);
    expect(credentialService.loadCredential).not.toHaveBeenCalled();
    expect(credentialService.saveCredential).not.toHaveBeenCalled();
  });
});

describe('CredentialManager.requestCredential', () => {
  it('records the auth config the client must fill in', () => {
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: API_KEY_SCHEME,
    };
    const context = makeContext({functionCallId: 'fc-1'});

    new CredentialManager(authConfig).requestCredential(context);

    expect(context.eventActions.requestedAuthConfigs['fc-1']).toEqual(
      authConfig,
    );
  });
});

// The suites below arrived with the BaseAuthenticatedTool pull request. They
// drive the manager through the registered exchangers rather than through a
// stubbed token endpoint, so both styles of coverage are kept.

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

const EXAMPLE_CLIENT_CREDENTIALS_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {clientCredentials: {tokenUrl: TOKEN_URL, scopes: {}}},
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
      'rawAuthCredential is required for auth scheme type oauth2',
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
      'rawAuthCredential is required for auth scheme type openIdConnect',
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
      'authConfig.rawAuthCredential.oauth2 is required for credential type oauth2',
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
      'authConfig.authScheme.flows.implicit.authorizationUrl is required for the declared OAuth2 flow',
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
    ).rejects.toThrow(
      'authConfig.authScheme.flows.password.tokenUrl is required for the declared OAuth2 flow',
    );
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
    ).rejects.toThrow(
      'authConfig.authScheme.flows.clientCredentials.tokenUrl is required for the declared OAuth2 flow',
    );
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
    ).rejects.toThrow(
      'authConfig.authScheme.flows.authorizationCode.tokenUrl is required for the declared OAuth2 flow',
    );
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
      authScheme: EXAMPLE_CLIENT_CREDENTIALS_SCHEME,
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
      authScheme: EXAMPLE_CLIENT_CREDENTIALS_SCHEME,
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
      authScheme: EXAMPLE_CLIENT_CREDENTIALS_SCHEME,
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
      authScheme: EXAMPLE_CLIENT_CREDENTIALS_SCHEME,
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
