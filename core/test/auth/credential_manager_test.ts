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
  BaseAuthProvider,
  BaseCredentialExchanger,
  BaseCredentialRefresher,
  BaseCredentialService,
  Context,
  CredentialManager,
  CustomAuthScheme,
  ExchangeResult,
  ExtendedOAuth2,
  InvocationContext,
  LlmAgent,
  OAuth2DiscoveryManager,
  OpenIdConnectWithConfig,
  PluginManager,
  createSession,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const AUTH_ENDPOINT = 'https://auth.example.com/authorize';
const TOKEN_ENDPOINT = 'https://auth.example.com/token';
const ISSUER_URL = 'https://auth.example.com';

/** Records every config handed to `saveCredential`, without copying it. */
class RecordingCredentialService implements BaseCredentialService {
  readonly saved: AuthConfig[] = [];
  private readonly store = new Map<string, AuthCredential>();

  seed(credentialKey: string, credential: AuthCredential): void {
    this.store.set(credentialKey, credential);
  }

  async loadCredential(
    authConfig: AuthConfig,
  ): Promise<AuthCredential | undefined> {
    return this.store.get(authConfig.credentialKey);
  }

  async saveCredential(authConfig: AuthConfig): Promise<void> {
    this.saved.push(authConfig);
    if (authConfig.exchangedAuthCredential) {
      this.store.set(
        authConfig.credentialKey,
        authConfig.exchangedAuthCredential,
      );
    }
  }
}

/** Returns the credential it was built with, and records its arguments. */
class StubAuthProvider implements BaseAuthProvider {
  readonly calls: Array<{authConfig: AuthConfig; context: Context}> = [];

  constructor(
    readonly supportedAuthSchemes: readonly string[],
    private readonly credential?: AuthCredential,
  ) {}

  async getAuthCredential(
    authConfig: AuthConfig,
    context: Context,
  ): Promise<AuthCredential | undefined> {
    this.calls.push({authConfig, context});
    return this.credential;
  }
}

/** Reports the credential as exchanged, tagging it so the swap is visible. */
class TaggingExchanger implements BaseCredentialExchanger {
  readonly schemes: Array<AuthScheme | undefined> = [];

  constructor(private readonly wasExchanged = true) {}

  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    this.schemes.push(params.authScheme);
    if (!this.wasExchanged) {
      return {credential: params.authCredential, wasExchanged: false};
    }
    return {
      credential: {...params.authCredential, apiKey: 'exchanged'},
      wasExchanged: true,
    };
  }
}

/** Refreshes on demand, and records the scheme both of its methods received. */
class RecordingRefresher implements BaseCredentialRefresher {
  readonly isRefreshNeededSchemes: Array<AuthScheme | undefined> = [];
  readonly refreshSchemes: Array<AuthScheme | undefined> = [];

  constructor(private readonly needed = true) {}

  async isRefreshNeeded(
    authCredential: AuthCredential,
    authScheme?: AuthScheme,
  ): Promise<boolean> {
    this.isRefreshNeededSchemes.push(authScheme);
    return this.needed;
  }

  async refresh(
    authCredential: AuthCredential,
    authScheme?: AuthScheme,
  ): Promise<AuthCredential> {
    this.refreshSchemes.push(authScheme);
    return {...authCredential, apiKey: 'refreshed'};
  }
}

function createToolContext(
  options: {
    credentialService?: BaseCredentialService;
    state?: Record<string, unknown>;
    userId?: string;
    functionCallId?: string;
    omitFunctionCallId?: boolean;
  } = {},
): Context {
  const session = createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: options.userId ?? 'user-1',
    state: options.state ?? {},
  });
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session,
    pluginManager: new PluginManager([]),
    credentialService: options.credentialService,
  });
  return new Context({
    invocationContext,
    functionCallId: options.omitFunctionCallId
      ? undefined
      : (options.functionCallId ?? 'function-call-1'),
  });
}

function apiKeyScheme(): OpenAPIV3.ApiKeySecurityScheme {
  return {type: 'apiKey', in: 'header', name: 'X-Api-Key'};
}

function authorizationCodeScheme(
  urls: {authorizationUrl?: string; tokenUrl?: string} = {},
): OpenAPIV3.OAuth2SecurityScheme {
  return {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: urls.authorizationUrl ?? AUTH_ENDPOINT,
        tokenUrl: urls.tokenUrl ?? TOKEN_ENDPOINT,
        scopes: {},
      },
    },
  };
}

function clientCredentialsScheme(): OpenAPIV3.OAuth2SecurityScheme {
  return {
    type: 'oauth2',
    flows: {clientCredentials: {tokenUrl: TOKEN_ENDPOINT, scopes: {}}},
  };
}

function oauth2Credential(oauth2: AuthCredential['oauth2']): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

function metadata() {
  return {
    issuer: ISSUER_URL,
    authorization_endpoint: AUTH_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
  };
}

function spyOnDiscovery(result: ReturnType<typeof metadata> | undefined) {
  return vi
    .spyOn(OAuth2DiscoveryManager.prototype, 'discoverAuthServerMetadata')
    .mockResolvedValue(result);
}

describe('CredentialManager.registerAuthProvider', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the provider for every supported scheme type', async () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'from-provider',
    };
    const provider = new StubAuthProvider(
      ['registerA1', 'registerA2'],
      credential,
    );

    CredentialManager.registerAuthProvider(provider);

    for (const type of ['registerA1', 'registerA2']) {
      const manager = new CredentialManager({
        authScheme: {type},
        credentialKey: `key-${type}`,
      });
      expect(await manager.getAuthCredential(createToolContext())).toBe(
        credential,
      );
    }
  });

  it('does not warn when the same instance is registered again', () => {
    const provider = new StubAuthProvider(['registerB'], {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'k',
    });

    CredentialManager.registerAuthProvider(provider);
    CredentialManager.registerAuthProvider(provider);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and keeps the first provider when a different one collides', async () => {
    const first = new StubAuthProvider(['registerC'], {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'first',
    });
    const second = new StubAuthProvider(['registerC'], {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'second',
    });

    CredentialManager.registerAuthProvider(first);
    CredentialManager.registerAuthProvider(second);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('already registered for scheme registerC'),
    );
    const manager = new CredentialManager({
      authScheme: {type: 'registerC'},
      credentialKey: 'key-c',
    });
    const resolved = await manager.getAuthCredential(createToolContext());
    expect(resolved?.apiKey).toBe('first');
  });

  it('registers nothing for a provider with no supported schemes', () => {
    class BareProvider implements BaseAuthProvider {
      async getAuthCredential(): Promise<AuthCredential | undefined> {
        return undefined;
      }
    }

    expect(() =>
      CredentialManager.registerAuthProvider(new BareProvider()),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('CredentialManager custom scheme resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the provider credential by identity and skips every other step', async () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'vault-key',
    };
    const provider = new StubAuthProvider(['customD'], credential);
    CredentialManager.registerAuthProvider(provider);
    const discovery = spyOnDiscovery(metadata());
    const credentialService = new RecordingCredentialService();
    const context = createToolContext({credentialService});
    const manager = new CredentialManager({
      authScheme: {type: 'customD'},
      credentialKey: 'key-d',
    });

    const resolved = await manager.getAuthCredential(context);

    expect(resolved).toBe(credential);
    expect(provider.calls[0].context).toBe(context);
    expect(credentialService.saved).toEqual([]);
    expect(discovery).not.toHaveBeenCalled();
  });

  it('throws and names the scheme type when no provider is registered', async () => {
    const manager = new CredentialManager({
      authScheme: {type: 'customUnregistered'},
      credentialKey: 'key-e',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      "No auth provider registered for custom auth scheme 'customUnregistered'.",
    );
  });

  it('throws when the provider returns nothing', async () => {
    CredentialManager.registerAuthProvider(
      new StubAuthProvider(['customF'], undefined),
    );
    const manager = new CredentialManager({
      authScheme: {type: 'customF'},
      credentialKey: 'key-f',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow('AuthProvider did not return a credential.');
  });

  it('asks for user consent when the provider returns an authUri with no access token', async () => {
    const consent = oauth2Credential({
      clientId: 'client',
      authUri: 'https://auth.example.com/authorize?state=abc',
    });
    CredentialManager.registerAuthProvider(
      new StubAuthProvider(['customG'], consent),
    );
    const authConfig: AuthConfig = {
      authScheme: {type: 'customG'},
      credentialKey: 'key-g',
    };
    const manager = new CredentialManager(authConfig);

    const resolved = await manager.getAuthCredential(createToolContext());

    expect(resolved).toBeUndefined();
    expect(authConfig.exchangedAuthCredential).toBe(consent);
  });

  it('returns an OAuth2 credential that already carries an access token', async () => {
    const authorized = oauth2Credential({
      accessToken: 'token',
      authUri: 'https://auth.example.com/authorize?state=abc',
    });
    CredentialManager.registerAuthProvider(
      new StubAuthProvider(['customH'], authorized),
    );
    const authConfig: AuthConfig = {
      authScheme: {type: 'customH'},
      credentialKey: 'key-h',
    };
    const manager = new CredentialManager(authConfig);

    const resolved = await manager.getAuthCredential(createToolContext());

    expect(resolved).toBe(authorized);
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('never consults the provider registry for an OpenAPI scheme', async () => {
    const provider = new StubAuthProvider(['apiKey'], {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'from-provider',
    });
    CredentialManager.registerAuthProvider(provider);
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-i',
      rawAuthCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'from-config',
      },
    });

    const resolved = await manager.getAuthCredential(createToolContext());

    expect(resolved?.apiKey).toBe('from-config');
    expect(provider.calls).toEqual([]);
  });

  it('resolves a custom scheme that survived a JSON round trip, with all its fields', async () => {
    interface VaultScheme extends CustomAuthScheme {
      type: 'customJ';
      vaultPath: string;
      audience: string;
    }
    const scheme: VaultScheme = {
      type: 'customJ',
      vaultPath: '/secret/data/tool',
      audience: 'tool-audience',
    };
    const provider = new StubAuthProvider(['customJ'], {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'vault',
    });
    CredentialManager.registerAuthProvider(provider);
    const revived = JSON.parse(JSON.stringify(scheme)) as AuthScheme;
    const manager = new CredentialManager({
      authScheme: revived,
      credentialKey: 'key-j',
    });

    await manager.getAuthCredential(createToolContext());

    expect(provider.calls[0].authConfig.authScheme).toEqual(scheme);
  });
});

describe('CredentialManager OAuth2 discovery fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function extendedScheme(
    options: {
      flows?: Partial<OpenAPIV3.OAuth2SecurityScheme['flows']>;
      omitIssuerUrl?: boolean;
    } = {},
  ): ExtendedOAuth2 {
    const scheme: ExtendedOAuth2 = {
      type: 'oauth2',
      flows: {
        authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
        ...options.flows,
      },
    };
    if (!options.omitIssuerUrl) {
      scheme.issuerUrl = ISSUER_URL;
    }
    return scheme;
  }

  function managerFor(authScheme: AuthScheme): CredentialManager {
    return new CredentialManager({
      authScheme,
      credentialKey: 'key-discovery',
      rawAuthCredential: oauth2Credential({
        clientId: 'client',
        clientSecret: 'secret',
        accessToken: 'token',
      }),
    });
  }

  it('fills the empty flow endpoints from the discovered metadata', async () => {
    const discovery = spyOnDiscovery(metadata());
    const authScheme = extendedScheme();

    await managerFor(authScheme).getAuthCredential(createToolContext());

    expect(discovery).toHaveBeenCalledWith(ISSUER_URL);
    expect(authScheme.flows.authorizationCode).toEqual({
      authorizationUrl: AUTH_ENDPOINT,
      tokenUrl: TOKEN_ENDPOINT,
      scopes: {},
    });
  });

  it('throws and leaves the flows empty when discovery finds nothing', async () => {
    spyOnDiscovery(undefined);
    const authScheme = extendedScheme();

    await expect(
      managerFor(authScheme).getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'OAuth scheme info is missing, and auto-discovery has failed to fill ' +
        'them in: authConfig.authScheme.flows.authorizationCode.authorizationUrl' +
        ' is required for the declared OAuth2 flow',
    );
    expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe('');
  });

  it('throws without attempting discovery when the scheme names no issuer', async () => {
    const discovery = spyOnDiscovery(metadata());
    const authScheme = extendedScheme({omitIssuerUrl: true});

    await expect(
      managerFor(authScheme).getAuthCredential(createToolContext()),
    ).rejects.toThrow('auto-discovery has failed to fill them in');
    expect(discovery).not.toHaveBeenCalled();
  });

  it('does not attempt discovery for a scheme with every endpoint set', async () => {
    const discovery = spyOnDiscovery(metadata());

    await managerFor(authorizationCodeScheme()).getAuthCredential(
      createToolContext(),
    );

    expect(discovery).not.toHaveBeenCalled();
  });

  it('leaves an endpoint that is already configured untouched', async () => {
    spyOnDiscovery(metadata());
    const authScheme = extendedScheme({
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://configured.example.com/authorize',
          tokenUrl: '',
          scopes: {},
        },
      },
    });

    await managerFor(authScheme).getAuthCredential(createToolContext());

    expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe(
      'https://configured.example.com/authorize',
    );
    expect(authScheme.flows.authorizationCode?.tokenUrl).toBe(TOKEN_ENDPOINT);
  });

  const missingFieldCases: Array<{
    field: string;
    flows: OpenAPIV3.OAuth2SecurityScheme['flows'];
  }> = [
    {
      field: 'flows.implicit.authorizationUrl',
      flows: {implicit: {authorizationUrl: '', scopes: {}}},
    },
    {
      field: 'flows.password.tokenUrl',
      flows: {password: {tokenUrl: '', scopes: {}}},
    },
    {
      field: 'flows.clientCredentials.tokenUrl',
      flows: {clientCredentials: {tokenUrl: '', scopes: {}}},
    },
    {
      field: 'flows.authorizationCode.authorizationUrl',
      flows: {
        authorizationCode: {
          authorizationUrl: '',
          tokenUrl: TOKEN_ENDPOINT,
          scopes: {},
        },
      },
    },
    {
      field: 'flows.authorizationCode.tokenUrl',
      flows: {
        authorizationCode: {
          authorizationUrl: AUTH_ENDPOINT,
          tokenUrl: '',
          scopes: {},
        },
      },
    },
  ];

  for (const {field, flows} of missingFieldCases) {
    it(`names ${field} in the error when it is the missing endpoint`, async () => {
      spyOnDiscovery(undefined);
      const authScheme: OpenAPIV3.OAuth2SecurityScheme = {
        type: 'oauth2',
        flows,
      };

      await expect(
        managerFor(authScheme).getAuthCredential(createToolContext()),
      ).rejects.toThrow(`authConfig.authScheme.${field} is required`);
    });
  }
});

describe('CredentialManager refresher registry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes an expired credential with the default OAuth2 refresher and saves it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({access_token: 'fresh-token', expires_in: 3600}),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        ),
      );
    const credentialService = new RecordingCredentialService();
    credentialService.seed(
      'key-refresh',
      oauth2Credential({
        clientId: 'client',
        clientSecret: 'secret',
        accessToken: 'stale-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 60_000,
      }),
    );
    const manager = new CredentialManager({
      authScheme: authorizationCodeScheme(),
      credentialKey: 'key-refresh',
      rawAuthCredential: oauth2Credential({
        clientId: 'client',
        clientSecret: 'secret',
      }),
    });

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(fetchSpy).toHaveBeenCalledWith(TOKEN_ENDPOINT, expect.anything());
    expect(resolved?.oauth2?.accessToken).toBe('fresh-token');
    expect(credentialService.saved).toHaveLength(1);
    expect(
      credentialService.saved[0].exchangedAuthCredential?.oauth2?.accessToken,
    ).toBe('fresh-token');
  });

  it('leaves a credential type with no registered refresher untouched', async () => {
    const credentialService = new RecordingCredentialService();
    const stored: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored',
    };
    credentialService.seed('key-no-refresher', stored);
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-no-refresher',
    });

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(resolved).toEqual(stored);
    expect(credentialService.saved).toEqual([]);
  });

  it('invokes a refresher registered for a type that has no default', async () => {
    const refresher = new RecordingRefresher();
    const credentialService = new RecordingCredentialService();
    credentialService.seed('key-api-refresh', {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stale',
    });
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-api-refresh',
    });
    manager.registerCredentialRefresher(AuthCredentialTypes.API_KEY, refresher);

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(resolved?.apiKey).toBe('refreshed');
    expect(credentialService.saved).toHaveLength(1);
  });

  it('replaces the default OAuth2 refresher', async () => {
    const refresher = new RecordingRefresher();
    const credentialService = new RecordingCredentialService();
    credentialService.seed(
      'key-replace-refresher',
      oauth2Credential({accessToken: 'stale'}),
    );
    const manager = new CredentialManager({
      authScheme: authorizationCodeScheme(),
      credentialKey: 'key-replace-refresher',
      rawAuthCredential: oauth2Credential({clientId: 'client'}),
    });
    manager.registerCredentialRefresher(AuthCredentialTypes.OAUTH2, refresher);

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(resolved?.apiKey).toBe('refreshed');
    expect(refresher.refreshSchemes).toHaveLength(1);
  });

  it('saves nothing when the refresher reports no refresh is needed', async () => {
    const refresher = new RecordingRefresher(false);
    const credentialService = new RecordingCredentialService();
    const stored: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored',
    };
    credentialService.seed('key-refresh-not-needed', stored);
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-refresh-not-needed',
    });
    manager.registerCredentialRefresher(AuthCredentialTypes.API_KEY, refresher);

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(resolved).toEqual(stored);
    expect(refresher.refreshSchemes).toEqual([]);
    expect(credentialService.saved).toEqual([]);
  });

  it('passes the auth scheme to both refresher methods', async () => {
    const refresher = new RecordingRefresher();
    const credentialService = new RecordingCredentialService();
    credentialService.seed('key-refresher-scheme', {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stale',
    });
    const authScheme = apiKeyScheme();
    const manager = new CredentialManager({
      authScheme,
      credentialKey: 'key-refresher-scheme',
    });
    manager.registerCredentialRefresher(AuthCredentialTypes.API_KEY, refresher);

    await manager.getAuthCredential(createToolContext({credentialService}));

    expect(refresher.isRefreshNeededSchemes).toEqual([authScheme]);
    expect(refresher.refreshSchemes).toEqual([authScheme]);
  });
});

describe('CredentialManager credential persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves a deep copy, so mutating the saved config cannot reach the live one', async () => {
    const credentialService = new RecordingCredentialService();
    const authScheme = apiKeyScheme();
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {scopes: ['original']},
    };
    const authConfig: AuthConfig = {
      authScheme,
      credentialKey: 'key-deep-copy',
      rawAuthCredential,
    };
    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      new TaggingExchanger(),
    );
    // A service account is never persisted, so route the save through a type
    // the manager does store.
    authConfig.rawAuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client'},
    };
    manager.registerCredentialExchanger(
      AuthCredentialTypes.OAUTH2,
      new TaggingExchanger(),
    );
    credentialService.seed('key-deep-copy', oauth2Credential({clientId: 'c'}));

    await manager.getAuthCredential(createToolContext({credentialService}));

    const savedConfig = credentialService.saved[0];
    expect(savedConfig).not.toBe(authConfig);
    savedConfig.authScheme.type = 'mutated';
    savedConfig.rawAuthCredential!.oauth2!.clientId = 'mutated';
    expect(authScheme.type).toBe('apiKey');
    expect(authConfig.rawAuthCredential?.oauth2?.clientId).toBe('client');
  });

  it('puts the resolved credential on the saved config and not on the live one', async () => {
    const credentialService = new RecordingCredentialService();
    credentialService.seed('key-save', {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored',
    });
    const authConfig: AuthConfig = {
      authScheme: apiKeyScheme(),
      credentialKey: 'key-save',
    };
    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(
      AuthCredentialTypes.API_KEY,
      new TaggingExchanger(),
    );

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(resolved?.apiKey).toBe('exchanged');
    expect(credentialService.saved[0].exchangedAuthCredential).toEqual(
      resolved,
    );
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('resolves without a credential service configured', async () => {
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-no-service',
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.API_KEY,
      new TaggingExchanger(),
    );
    const context = createToolContext({
      state: {
        'temp:key-no-service': {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'from-response',
        },
      },
    });

    const resolved = await manager.getAuthCredential(context);

    expect(resolved?.apiKey).toBe('exchanged');
  });
});

describe('CredentialManager.requestCredential', () => {
  it('records the request against the function call id', () => {
    const authConfig: AuthConfig = {
      authScheme: authorizationCodeScheme(),
      credentialKey: 'key-request',
      rawAuthCredential: oauth2Credential({
        clientId: 'client',
        clientSecret: 'secret',
      }),
    };
    const context = createToolContext({functionCallId: 'call-42'});

    new CredentialManager(authConfig).requestCredential(context);

    expect(context.eventActions.requestedAuthConfigs['call-42']).toBeDefined();
  });

  it('throws for a context that is not a tool call', () => {
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-no-function-call',
    });

    expect(() =>
      manager.requestCredential(createToolContext({omitFunctionCallId: true})),
    ).toThrow('functionCallId is not set.');
  });

  it('does not leak one user resolved credential into another user request', async () => {
    const credentialService = new RecordingCredentialService();
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'shared-secret',
    };
    const authConfig: AuthConfig = {
      authScheme: apiKeyScheme(),
      credentialKey: 'key-users',
      rawAuthCredential,
    };
    const manager = new CredentialManager(authConfig);

    const first = await manager.getAuthCredential(
      createToolContext({credentialService, userId: 'user-1'}),
    );
    first!.apiKey = 'user-1-only';
    const second = await manager.getAuthCredential(
      createToolContext({credentialService, userId: 'user-2'}),
    );

    expect(second?.apiKey).toBe('shared-secret');
    expect(rawAuthCredential.apiKey).toBe('shared-secret');
  });
});

describe('CredentialManager core flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['apiKey', {authType: AuthCredentialTypes.API_KEY, apiKey: 'k'}],
    [
      'http',
      {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'u', password: 'p'}},
      },
    ],
  ] as const)(
    'returns a copy of a ready %s credential without touching the store',
    async (_name, rawAuthCredential) => {
      const credentialService = new RecordingCredentialService();
      const loadSpy = vi.spyOn(credentialService, 'loadCredential');
      const manager = new CredentialManager({
        authScheme: apiKeyScheme(),
        credentialKey: 'key-ready',
        rawAuthCredential,
      });

      const resolved = await manager.getAuthCredential(
        createToolContext({credentialService}),
      );

      expect(resolved).toEqual(rawAuthCredential);
      expect(resolved).not.toBe(rawAuthCredential);
      expect(loadSpy).not.toHaveBeenCalled();
    },
  );

  it('does not treat an OAuth2 raw credential as ready', async () => {
    const credentialService = new RecordingCredentialService();
    const loadSpy = vi.spyOn(credentialService, 'loadCredential');
    const manager = new CredentialManager({
      authScheme: authorizationCodeScheme(),
      credentialKey: 'key-not-ready',
      rawAuthCredential: oauth2Credential({clientId: 'client'}),
    });

    await manager.getAuthCredential(createToolContext({credentialService}));

    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('prefers the stored credential over the auth response', async () => {
    const credentialService = new RecordingCredentialService();
    const stored: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored',
    };
    credentialService.seed('key-prefer-store', stored);
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-prefer-store',
    });

    const resolved = await manager.getAuthCredential(
      createToolContext({
        credentialService,
        state: {
          'temp:key-prefer-store': {
            authType: AuthCredentialTypes.API_KEY,
            apiKey: 'from-response',
          },
        },
      }),
    );

    expect(resolved).toEqual(stored);
  });

  it('saves the credential it fell back to the auth response for', async () => {
    const credentialService = new RecordingCredentialService();
    const fromResponse: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'from-response',
    };
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-auth-response',
    });

    const resolved = await manager.getAuthCredential(
      createToolContext({
        credentialService,
        state: {'temp:key-auth-response': fromResponse},
      }),
    );

    expect(resolved).toEqual(fromResponse);
    expect(credentialService.saved).toHaveLength(1);
  });

  it('resolves to undefined for an authorization code flow with nothing stored', async () => {
    const credentialService = new RecordingCredentialService();
    const manager = new CredentialManager({
      authScheme: authorizationCodeScheme(),
      credentialKey: 'key-needs-consent',
      rawAuthCredential: oauth2Credential({clientId: 'client'}),
    });

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(resolved).toBeUndefined();
    expect(credentialService.saved).toEqual([]);
  });

  const clientCredentialsCases: Array<{
    name: string;
    authScheme: AuthScheme;
    expected: boolean;
  }> = [
    {
      name: 'an OAuth2 scheme declaring the clientCredentials flow',
      authScheme: clientCredentialsScheme(),
      expected: true,
    },
    {
      name: 'an OAuth2 scheme declaring only the authorizationCode flow',
      authScheme: authorizationCodeScheme(),
      expected: false,
    },
    {
      name: 'an OIDC scheme listing client_credentials',
      authScheme: {
        type: 'openIdConnect',
        openIdConnectUrl: ISSUER_URL,
        authorizationEndpoint: AUTH_ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        grantTypesSupported: ['client_credentials'],
      } satisfies OpenIdConnectWithConfig,
      expected: true,
    },
    {
      name: 'an OIDC scheme listing only authorization_code',
      authScheme: {
        type: 'openIdConnect',
        openIdConnectUrl: ISSUER_URL,
        authorizationEndpoint: AUTH_ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        grantTypesSupported: ['authorization_code'],
      } satisfies OpenIdConnectWithConfig,
      expected: false,
    },
    {
      name: 'a scheme that is neither OAuth2 nor OIDC',
      authScheme: apiKeyScheme(),
      expected: false,
    },
  ];

  for (const {name, authScheme, expected} of clientCredentialsCases) {
    it(`${expected ? 'uses' : 'does not use'} a copy of the raw credential for ${name}`, async () => {
      const rawAuthCredential = oauth2Credential({
        clientId: 'client',
        clientSecret: 'secret',
      });
      const exchanger = new TaggingExchanger();
      const manager = new CredentialManager({
        authScheme,
        credentialKey: 'key-client-credentials',
        rawAuthCredential,
      });
      manager.registerCredentialExchanger(
        AuthCredentialTypes.OAUTH2,
        exchanger,
      );
      manager.registerCredentialExchanger(
        AuthCredentialTypes.OPEN_ID_CONNECT,
        exchanger,
      );

      const resolved = await manager.getAuthCredential(createToolContext());

      if (!expected) {
        expect(resolved).toBeUndefined();
        return;
      }
      expect(resolved?.apiKey).toBe('exchanged');
      expect(resolved).not.toBe(rawAuthCredential);
      expect(rawAuthCredential.apiKey).toBeUndefined();
    });
  }

  it('neither loads nor saves a service account credential, but does exchange it', async () => {
    const credentialService = new RecordingCredentialService();
    const loadSpy = vi.spyOn(credentialService, 'loadCredential');
    const exchanger = new TaggingExchanger();
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-service-account',
      rawAuthCredential: {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      },
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      exchanger,
    );
    const context = createToolContext({
      credentialService,
      state: {
        'temp:key-service-account': {
          authType: AuthCredentialTypes.SERVICE_ACCOUNT,
          serviceAccount: {useDefaultCredential: true},
        },
      },
    });

    const resolved = await manager.getAuthCredential(context);

    expect(resolved?.apiKey).toBe('exchanged');
    expect(loadSpy).not.toHaveBeenCalled();
    expect(credentialService.saved).toEqual([]);
  });

  it('returns a credential unexchanged when no exchanger serves its type', async () => {
    const credentialService = new RecordingCredentialService();
    const stored: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored',
    };
    credentialService.seed('key-no-exchanger', stored);
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-no-exchanger',
    });

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(resolved).toEqual(stored);
    expect(credentialService.saved).toEqual([]);
  });

  it('installs an exchanger for a type with no default, and replaces one that has a default', async () => {
    const credentialService = new RecordingCredentialService();
    credentialService.seed('key-exchanger', {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored',
    });
    const added = new TaggingExchanger();
    const first = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-exchanger',
    });
    first.registerCredentialExchanger(AuthCredentialTypes.API_KEY, added);

    expect(
      (await first.getAuthCredential(createToolContext({credentialService})))
        ?.apiKey,
    ).toBe('exchanged');

    const replacement = new TaggingExchanger();
    const oauth2Service = new RecordingCredentialService();
    oauth2Service.seed(
      'key-exchanger-oauth2',
      oauth2Credential({clientId: 'client'}),
    );
    const second = new CredentialManager({
      authScheme: authorizationCodeScheme(),
      credentialKey: 'key-exchanger-oauth2',
      rawAuthCredential: oauth2Credential({clientId: 'client'}),
    });
    second.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, replacement);

    const resolved = await second.getAuthCredential(
      createToolContext({credentialService: oauth2Service}),
    );

    expect(resolved?.apiKey).toBe('exchanged');
    expect(replacement.schemes).toHaveLength(1);
  });

  it('does not refresh after a successful exchange', async () => {
    const refresher = new RecordingRefresher();
    const credentialService = new RecordingCredentialService();
    credentialService.seed('key-exchange-wins', {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored',
    });
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-exchange-wins',
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.API_KEY,
      new TaggingExchanger(),
    );
    manager.registerCredentialRefresher(AuthCredentialTypes.API_KEY, refresher);

    const resolved = await manager.getAuthCredential(
      createToolContext({credentialService}),
    );

    expect(resolved?.apiKey).toBe('exchanged');
    expect(refresher.isRefreshNeededSchemes).toEqual([]);
  });

  it('does not save a credential that neither the exchanger nor the refresher changed', async () => {
    const credentialService = new RecordingCredentialService();
    credentialService.seed('key-unchanged', {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'stored',
    });
    const manager = new CredentialManager({
      authScheme: apiKeyScheme(),
      credentialKey: 'key-unchanged',
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.API_KEY,
      new TaggingExchanger(false),
    );

    await manager.getAuthCredential(createToolContext({credentialService}));

    expect(credentialService.saved).toEqual([]);
  });

  it('rejects an OAuth2 scheme with no raw credential', async () => {
    const manager = new CredentialManager({
      authScheme: authorizationCodeScheme(),
      credentialKey: 'key-missing-raw',
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'rawAuthCredential is required for auth scheme type oauth2',
    );
  });

  it('rejects an OAuth2 raw credential with no oauth2 block', async () => {
    const manager = new CredentialManager({
      authScheme: authorizationCodeScheme(),
      credentialKey: 'key-missing-oauth2',
      rawAuthCredential: {authType: AuthCredentialTypes.OAUTH2},
    });

    await expect(
      manager.getAuthCredential(createToolContext()),
    ).rejects.toThrow(
      'authConfig.rawAuthCredential.oauth2 is required for credential type oauth2',
    );
  });
});
