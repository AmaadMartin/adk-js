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
  BaseCredentialService,
  Context,
  CredentialManager,
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
