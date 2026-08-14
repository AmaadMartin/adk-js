/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthProviderRegistry,
  AuthScheme,
  BaseAuthProvider,
  BaseCredentialExchanger,
  BaseCredentialService,
  Context,
  createSession,
  CredentialManager,
  CustomAuthConfig,
  getCustomSchemeCredential,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  registerAuthProvider,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import * as oauth2Utils from '../../src/auth/oauth2/oauth2_utils.js';
import {logger} from '../../src/utils/logger.js';

// Only the network call is stubbed; `isTokenExpired` and `getTokenEndpoint`
// keep their real behaviour so the refresh decision is the production one.
vi.mock('../../src/auth/oauth2/oauth2_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof oauth2Utils>()),
  fetchOAuth2Tokens: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({
      getAccessToken: vi.fn().mockResolvedValue({token: 'mock-adc-token'}),
    }),
  })),
}));

const CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'Bearer', credentials: {token: 'tok-123'}},
};

/**
 * A provider whose returned credential and declared scheme types are set per
 * test. `getAuthCredential` is a spy so call arguments can be asserted.
 *
 * `registerAuthProvider` writes to a process-wide registry with no reset, so
 * every test below claims a scheme type unique to itself.
 */
class FakeAuthProvider implements BaseAuthProvider {
  readonly getAuthCredential = vi
    .fn<BaseAuthProvider['getAuthCredential']>()
    .mockResolvedValue(CREDENTIAL);

  constructor(readonly supportedAuthSchemes: readonly string[]) {}
}

function makeAuthConfig(type: string): CustomAuthConfig {
  return {authScheme: {type}, credentialKey: `${type}_key`};
}

function makeContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'sess-1', appName: 'app', userId: 'user-1'}),
      pluginManager: new PluginManager([]),
    }),
  );
}

describe('getCustomSchemeCredential', () => {
  it('resolves the credential from the registered provider', async () => {
    registerAuthProvider(new FakeAuthProvider(['resolvedScheme']));

    await expect(
      getCustomSchemeCredential(makeAuthConfig('resolvedScheme')),
    ).resolves.toBe(CREDENTIAL);
  });

  it('throws naming the scheme type when no provider is registered', async () => {
    await expect(
      getCustomSchemeCredential(makeAuthConfig('unregisteredScheme')),
    ).rejects.toThrow(/unregisteredScheme.*registerAuthProvider/s);
  });

  it('throws when the provider resolves no credential', async () => {
    const provider = new FakeAuthProvider(['emptyScheme']);
    provider.getAuthCredential.mockResolvedValue(undefined);
    registerAuthProvider(provider);

    await expect(
      getCustomSchemeCredential(makeAuthConfig('emptyScheme')),
    ).rejects.toThrow('AuthProvider did not return a credential.');
  });

  it('propagates a provider rejection unchanged', async () => {
    const provider = new FakeAuthProvider(['failingScheme']);
    provider.getAuthCredential.mockRejectedValue(new Error('minting failed'));
    registerAuthProvider(provider);

    await expect(
      getCustomSchemeCredential(makeAuthConfig('failingScheme')),
    ).rejects.toThrow('minting failed');
  });

  it('passes the auth config and the context through to the provider', async () => {
    const provider = new FakeAuthProvider(['passthroughScheme']);
    registerAuthProvider(provider);
    const authConfig = makeAuthConfig('passthroughScheme');
    const context = makeContext();

    await getCustomSchemeCredential(authConfig, context);

    expect(provider.getAuthCredential).toHaveBeenCalledWith(
      authConfig,
      context,
    );
  });
});

describe('registerAuthProvider', () => {
  it('registers the provider under every supported scheme type', async () => {
    const provider = new FakeAuthProvider(['multiSchemeA', 'multiSchemeB']);

    registerAuthProvider(provider);

    await expect(
      getCustomSchemeCredential(makeAuthConfig('multiSchemeA')),
    ).resolves.toBe(CREDENTIAL);
    await expect(
      getCustomSchemeCredential(makeAuthConfig('multiSchemeB')),
    ).resolves.toBe(CREDENTIAL);
  });

  it('makes the provider resolvable through the default registry', async () => {
    const provider = new FakeAuthProvider(['defaultRegistryScheme']);

    registerAuthProvider(provider);

    await getCustomSchemeCredential(makeAuthConfig('defaultRegistryScheme'));
    expect(provider.getAuthCredential).toHaveBeenCalledOnce();
  });

  it('keeps the first provider and warns when a second one claims the scheme', async () => {
    const first = new FakeAuthProvider(['contestedScheme']);
    const second = new FakeAuthProvider(['contestedScheme']);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    registerAuthProvider(first);
    registerAuthProvider(second);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('contestedScheme'),
    );
    await getCustomSchemeCredential(makeAuthConfig('contestedScheme'));
    expect(first.getAuthCredential).toHaveBeenCalledOnce();
    expect(second.getAuthCredential).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn when the same provider instance registers twice', () => {
    const provider = new FakeAuthProvider(['idempotentScheme']);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    registerAuthProvider(provider);
    registerAuthProvider(provider);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};
const HTTP_SCHEME: AuthScheme = {type: 'http', scheme: 'bearer'};
const OIDC_SCHEME: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
};
const AUTHORIZATION_CODE_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: {},
    },
  },
};
const CLIENT_CREDENTIALS_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    clientCredentials: {tokenUrl: 'https://example.com/token', scopes: {}},
  },
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'secret-key',
};

/** A credential service whose two calls are spies. */
class FakeCredentialService implements BaseCredentialService {
  readonly loadCredential = vi
    .fn<BaseCredentialService['loadCredential']>()
    .mockResolvedValue(undefined);
  readonly saveCredential = vi
    .fn<BaseCredentialService['saveCredential']>()
    .mockResolvedValue(undefined);
}

/** An exchanger whose result is set per test. */
class StubExchanger implements BaseCredentialExchanger {
  readonly exchange = vi.fn<BaseCredentialExchanger['exchange']>();
}

function makeToolContext(
  options: {
    credentialService?: BaseCredentialService;
    state?: Record<string, unknown>;
  } = {},
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({
      id: 'sess-1',
      appName: 'app',
      userId: 'user-1',
      state: options.state,
    }),
    pluginManager: new PluginManager([]),
  });

  return new Context({
    // The InvocationContext constructor accepts `credentialService` and then
    // drops it, so the Runner's service never reaches a tool. AmaadMartin/adk-js#771
    // fixes that; attach it here until it lands.
    invocationContext: Object.assign(invocationContext, {
      credentialService: options.credentialService,
    }),
    functionCallId: 'fc-1',
  });
}

/**
 * Builds a manager over an isolated provider registry, so a provider one test
 * registers is invisible to the next.
 */
function makeManager(
  authConfig: AuthConfig,
  authProviderRegistry = new AuthProviderRegistry(),
): CredentialManager {
  return new CredentialManager(authConfig, {authProviderRegistry});
}

describe('CredentialManager provider dispatch', () => {
  it('returns the credential from the provider registered for the scheme type', async () => {
    const provider = new FakeAuthProvider(['apiKey']);
    const providerRegistry = new AuthProviderRegistry();
    providerRegistry.register('apiKey', provider);
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      credentialKey: 'provider_key',
    };
    const context = makeToolContext();

    const credential = await makeManager(
      authConfig,
      providerRegistry,
    ).getAuthCredential(context);

    expect(credential).toBe(CREDENTIAL);
    expect(provider.getAuthCredential).toHaveBeenCalledWith(
      authConfig,
      context,
    );
  });

  it('records the consent credential and returns undefined when the provider returns an auth uri', async () => {
    const consentCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {authUri: 'https://example.com/auth?state=abc'},
    };
    const provider = new FakeAuthProvider(['apiKey']);
    provider.getAuthCredential.mockResolvedValue(consentCredential);
    const providerRegistry = new AuthProviderRegistry();
    providerRegistry.register('apiKey', provider);
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      credentialKey: 'consent_key',
    };

    const credential = await makeManager(
      authConfig,
      providerRegistry,
    ).getAuthCredential(makeToolContext());

    expect(credential).toBeUndefined();
    expect(authConfig.exchangedAuthCredential).toBe(consentCredential);
  });

  it('returns the provider credential when it already carries an access token', async () => {
    const tokenCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {authUri: 'https://example.com/auth', accessToken: 'tok-live'},
    };
    const provider = new FakeAuthProvider(['apiKey']);
    provider.getAuthCredential.mockResolvedValue(tokenCredential);
    const providerRegistry = new AuthProviderRegistry();
    providerRegistry.register('apiKey', provider);
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      credentialKey: 'token_key',
    };

    const credential = await makeManager(
      authConfig,
      providerRegistry,
    ).getAuthCredential(makeToolContext());

    expect(credential).toBe(tokenCredential);
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('throws when the registered provider resolves no credential', async () => {
    const provider = new FakeAuthProvider(['apiKey']);
    provider.getAuthCredential.mockResolvedValue(undefined);
    const providerRegistry = new AuthProviderRegistry();
    providerRegistry.register('apiKey', provider);

    await expect(
      makeManager(
        {authScheme: API_KEY_SCHEME, credentialKey: 'empty_key'},
        providerRegistry,
      ).getAuthCredential(makeToolContext()),
    ).rejects.toThrow('AuthProvider did not return a credential.');
  });

  it('runs the standard flow when no provider serves the scheme type', async () => {
    const provider = new FakeAuthProvider(['someOtherScheme']);
    const providerRegistry = new AuthProviderRegistry();
    providerRegistry.register('someOtherScheme', provider);

    const credential = await makeManager(
      {
        authScheme: API_KEY_SCHEME,
        rawAuthCredential: API_KEY_CREDENTIAL,
        credentialKey: 'fallback_key',
      },
      providerRegistry,
    ).getAuthCredential(makeToolContext());

    expect(credential).toEqual(API_KEY_CREDENTIAL);
    expect(provider.getAuthCredential).not.toHaveBeenCalled();
  });

  it('resolves through the process-wide registry when none is injected', async () => {
    const provider = new FakeAuthProvider(['http']);
    registerAuthProvider(provider);

    const credential = await new CredentialManager({
      authScheme: HTTP_SCHEME,
      credentialKey: 'process_wide_key',
    }).getAuthCredential(makeToolContext());

    expect(credential).toBe(CREDENTIAL);
  });
});

describe('CredentialManager validation', () => {
  it('throws when an oauth2 scheme has no raw credential', async () => {
    await expect(
      makeManager({
        authScheme: AUTHORIZATION_CODE_SCHEME,
        credentialKey: 'no_raw_oauth2',
      }).getAuthCredential(makeToolContext()),
    ).rejects.toThrow(
      'rawAuthCredential is required for auth scheme type oauth2',
    );
  });

  it('throws when an openIdConnect scheme has no raw credential', async () => {
    await expect(
      makeManager({
        authScheme: OIDC_SCHEME,
        credentialKey: 'no_raw_oidc',
      }).getAuthCredential(makeToolContext()),
    ).rejects.toThrow(
      'rawAuthCredential is required for auth scheme type openIdConnect',
    );
  });

  it('accepts an apiKey scheme with no raw credential and reports nothing available', async () => {
    const context = makeToolContext();

    const credential = await makeManager({
      authScheme: API_KEY_SCHEME,
      credentialKey: 'no_raw_api_key',
    }).getAuthCredential(context);

    expect(credential).toBeUndefined();
  });

  it('throws when an oauth2 raw credential carries no oauth2 block', async () => {
    await expect(
      makeManager({
        authScheme: AUTHORIZATION_CODE_SCHEME,
        rawAuthCredential: {authType: AuthCredentialTypes.OAUTH2},
        credentialKey: 'raw_without_oauth2',
      }).getAuthCredential(makeToolContext()),
    ).rejects.toThrow(
      'authConfig.rawAuthCredential.oauth2 required for credential type oauth2',
    );
  });
});

describe('CredentialManager ready credentials', () => {
  it('returns a copy of an apiKey raw credential without consulting the credential service', async () => {
    const credentialService = new FakeCredentialService();
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      rawAuthCredential: API_KEY_CREDENTIAL,
      credentialKey: 'ready_api_key',
    };

    const credential = await makeManager(authConfig).getAuthCredential(
      makeToolContext({credentialService}),
    );

    expect(credential).toEqual(API_KEY_CREDENTIAL);
    expect(credential).not.toBe(API_KEY_CREDENTIAL);
    expect(credentialService.loadCredential).not.toHaveBeenCalled();
  });

  it('returns a copy of an http raw credential', async () => {
    const rawCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'static-token'}},
    };
    const credentialService = new FakeCredentialService();

    const credential = await makeManager({
      authScheme: HTTP_SCHEME,
      rawAuthCredential: rawCredential,
      credentialKey: 'ready_http',
    }).getAuthCredential(makeToolContext({credentialService}));

    expect(credential).toEqual(rawCredential);
    expect(credential).not.toBe(rawCredential);
    expect(credential?.http).not.toBe(rawCredential.http);
    expect(credentialService.loadCredential).not.toHaveBeenCalled();
  });
});

describe('CredentialManager load, refresh and save', () => {
  const OAUTH2_RAW_CREDENTIAL: AuthCredential = {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
  };

  beforeEach(() => {
    vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockClear();
  });

  it('returns the credential the credential service holds and saves nothing', async () => {
    const stored: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'stored-token'},
    };
    const credentialService = new FakeCredentialService();
    credentialService.loadCredential.mockResolvedValue(stored);

    const credential = await makeManager({
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_RAW_CREDENTIAL,
      credentialKey: 'stored_key',
    }).getAuthCredential(makeToolContext({credentialService}));

    expect(credential).toBe(stored);
    expect(credentialService.saveCredential).not.toHaveBeenCalled();
  });

  it('falls back to the auth response and saves it on a copy of the config', async () => {
    const fromClient: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'client-token'},
    };
    const credentialService = new FakeCredentialService();
    const authConfig: AuthConfig = {
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_RAW_CREDENTIAL,
      credentialKey: 'auth_response_key',
    };
    const context = makeToolContext({
      credentialService,
      state: {'temp:auth_response_key': fromClient},
    });

    const credential = await makeManager(authConfig).getAuthCredential(context);

    expect(credential).toBe(fromClient);
    expect(credentialService.saveCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialKey: 'auth_response_key',
        exchangedAuthCredential: fromClient,
      }),
      context,
    );
    // The saved config is a copy, so one user's token never lands on the
    // config the tool shares across invocations.
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('reports nothing available on an authorization-code scheme and requests no credential', async () => {
    const context = makeToolContext();

    const credential = await makeManager({
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_RAW_CREDENTIAL,
      credentialKey: 'pending_key',
    }).getAuthCredential(context);

    expect(credential).toBeUndefined();
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('exchanges a copy of the raw credential on a client-credentials scheme and saves the result', async () => {
    const exchanged: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'minted-token'},
    };
    const exchanger = new StubExchanger();
    exchanger.exchange.mockResolvedValue({
      credential: exchanged,
      wasExchanged: true,
    });
    const credentialService = new FakeCredentialService();
    const authConfig: AuthConfig = {
      authScheme: CLIENT_CREDENTIALS_SCHEME,
      rawAuthCredential: OAUTH2_RAW_CREDENTIAL,
      credentialKey: 'client_credentials_key',
    };
    const manager = makeManager(authConfig);
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);

    const credential = await manager.getAuthCredential(
      makeToolContext({credentialService}),
    );

    expect(credential).toBe(exchanged);
    const handedToExchanger =
      exchanger.exchange.mock.calls[0][0].authCredential;
    expect(handedToExchanger).toEqual(OAUTH2_RAW_CREDENTIAL);
    // A copy: exchange and refresh may rewrite the credential in place, and the
    // raw credential is shared with every other invocation of the tool.
    expect(handedToExchanger).not.toBe(OAUTH2_RAW_CREDENTIAL);
    expect(credentialService.saveCredential).toHaveBeenCalledOnce();
  });

  it('refreshes an expired credential and saves the refreshed one', async () => {
    const expired: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accessToken: 'stale-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 60_000,
      },
    };
    const credentialService = new FakeCredentialService();
    credentialService.loadCredential.mockResolvedValue(expired);
    vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue({
      accessToken: 'fresh-token',
      expiresAt: Date.now() + 3_600_000,
    });

    const credential = await makeManager({
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_RAW_CREDENTIAL,
      credentialKey: 'refresh_key',
    }).getAuthCredential(makeToolContext({credentialService}));

    expect(credential?.oauth2?.accessToken).toBe('fresh-token');
    expect(credentialService.saveCredential).toHaveBeenCalledWith(
      expect.objectContaining({exchangedAuthCredential: credential}),
      expect.anything(),
    );
  });

  it('does not refresh a credential that was exchanged in the same pass', async () => {
    const exchangedButExpired: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accessToken: 'exchanged-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 60_000,
      },
    };
    const exchanger = new StubExchanger();
    exchanger.exchange.mockResolvedValue({
      credential: exchangedButExpired,
      wasExchanged: true,
    });
    const credentialService = new FakeCredentialService();
    credentialService.loadCredential.mockResolvedValue({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    });
    const manager = makeManager({
      authScheme: AUTHORIZATION_CODE_SCHEME,
      rawAuthCredential: OAUTH2_RAW_CREDENTIAL,
      credentialKey: 'no_double_pass_key',
    });
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);

    const credential = await manager.getAuthCredential(
      makeToolContext({credentialService}),
    );

    expect(credential).toBe(exchangedButExpired);
    expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
  });

  it('returns an apiKey credential from the credential service untouched and saves nothing', async () => {
    const credentialService = new FakeCredentialService();
    credentialService.loadCredential.mockResolvedValue(API_KEY_CREDENTIAL);

    const credential = await makeManager({
      authScheme: API_KEY_SCHEME,
      credentialKey: 'api_key_from_service',
    }).getAuthCredential(makeToolContext({credentialService}));

    expect(credential).toBe(API_KEY_CREDENTIAL);
    expect(credentialService.saveCredential).not.toHaveBeenCalled();
  });
});

describe('CredentialManager.exchangeCredential', () => {
  it('returns the credential unchanged when no exchanger serves its type', async () => {
    const result = await makeManager({
      authScheme: API_KEY_SCHEME,
      credentialKey: 'no_exchanger_key',
    }).exchangeCredential(API_KEY_CREDENTIAL);

    expect(result).toEqual({
      credential: API_KEY_CREDENTIAL,
      wasExchanged: false,
    });
  });

  it('routes a service account credential to the service account exchanger', async () => {
    const result = await makeManager({
      authScheme: API_KEY_SCHEME,
      credentialKey: 'service_account_key',
    }).exchangeCredential({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-adc-token');
  });

  it('prefers an exchanger registered for the credential type over the default', async () => {
    const overridden: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'override-token'}},
    };
    const exchanger = new StubExchanger();
    exchanger.exchange.mockResolvedValue({
      credential: overridden,
      wasExchanged: true,
    });
    const manager = makeManager({
      authScheme: API_KEY_SCHEME,
      credentialKey: 'override_key',
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      exchanger,
    );

    const result = await manager.exchangeCredential({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    });

    expect(result.credential).toBe(overridden);
  });
});

describe('CredentialManager.requestCredential', () => {
  it('asks the client for the credential this manager owns', () => {
    const authConfig: AuthConfig = {
      authScheme: API_KEY_SCHEME,
      credentialKey: 'request_key',
    };
    const context = makeToolContext();

    makeManager(authConfig).requestCredential(context);

    expect(context.eventActions.requestedAuthConfigs['fc-1']).toBe(authConfig);
  });
});
