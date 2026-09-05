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
  BaseCredentialService,
  Context,
  CredentialManager,
  ExchangeResult,
  ExtendedOAuth2,
  InvocationContext,
  OAuth2DiscoveryManager,
  OpenIdConnectWithConfig,
  PluginManager,
  createSession,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  isClientCredentialsFlow,
  isCredentialReady,
  missingOAuthInfo,
  populateAuthScheme,
  validateCredential,
} from '../../src/auth/credential_manager.js';
import {OAuth2CredentialRefresher} from '../../src/auth/oauth2/oauth2_credential_refresher.js';
import {AuthorizationServerMetadata} from '../../src/auth/oauth2/oauth2_discovery.js';
import {logger} from '../../src/utils/logger.js';

/**
 * Builds a scheme whose `type` is outside the OpenAPI set. `AuthScheme` is a
 * closed union of the four OpenAPI scheme types, so a custom scheme needs one
 * widening step to reach it.
 */
function customAuthScheme(
  type: string,
  extra: Record<string, unknown> = {},
): AuthScheme {
  const scheme: {type: string} = {type, ...extra};
  return scheme as AuthScheme;
}

function apiKeyScheme(): AuthScheme {
  return {type: 'apiKey', name: 'api_key', in: 'header'};
}

function authorizationCodeScheme(
  authorizationUrl = 'https://example.com/authorize',
  tokenUrl = 'https://example.com/token',
): OpenAPIV3.OAuth2SecurityScheme {
  return {
    type: 'oauth2',
    flows: {authorizationCode: {authorizationUrl, tokenUrl, scopes: {}}},
  };
}

function clientCredentialsScheme(): OpenAPIV3.OAuth2SecurityScheme {
  return {
    type: 'oauth2',
    flows: {
      clientCredentials: {tokenUrl: 'https://example.com/token', scopes: {}},
    },
  };
}

function oidcScheme(grantTypesSupported?: string[]): OpenIdConnectWithConfig {
  return {
    type: 'openIdConnect',
    openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
    authorizationEndpoint: 'https://example.com/authorize',
    tokenEndpoint: 'https://example.com/token',
    grantTypesSupported,
  };
}

/** An OAuth2 scheme carrying an issuer URL, with both endpoints empty. */
function discoverableScheme(): ExtendedOAuth2 {
  return {
    type: 'oauth2',
    issuerUrl: 'https://auth.example.com',
    flows: {
      authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
    },
  };
}

function flowsOf(scheme: AuthScheme): OpenAPIV3.OAuth2SecurityScheme['flows'] {
  if (scheme.type !== 'oauth2') {
    expect.fail('expected an OAuth2 scheme');
  }
  return scheme.flows;
}

function apiKeyCredential(apiKey = 'raw-key'): AuthCredential {
  return {authType: AuthCredentialTypes.API_KEY, apiKey};
}

function oauth2Credential(oauth2: AuthCredential['oauth2']): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

function serverMetadata(): AuthorizationServerMetadata {
  return {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
  };
}

function makeContext(
  options: {
    credentialService?: BaseCredentialService;
    sessionId?: string;
    userId?: string;
    functionCallId?: string;
    state?: Record<string, unknown>;
  } = {},
): Context {
  const invocationContext = new InvocationContext({
    invocationId: `invocation-${options.sessionId ?? 'default'}`,
    session: createSession({
      id: options.sessionId ?? 'session-1',
      appName: 'test-app',
      userId: options.userId ?? 'user-1',
      state: options.state,
    }),
    pluginManager: new PluginManager(),
    credentialService: options.credentialService,
  });
  return new Context({
    invocationContext,
    functionCallId: options.functionCallId ?? 'call-1',
  });
}

/** A credential service whose two calls are observable. */
function fakeCredentialService(stored?: AuthCredential) {
  return {
    loadCredential: vi.fn(
      async (_authConfig: AuthConfig, _context: Context) => stored,
    ),
    saveCredential: vi.fn(
      async (_authConfig: AuthConfig, _context: Context) => {},
    ),
  } satisfies BaseCredentialService;
}

/** An exchanger that reports the credential it was handed. */
function fakeExchanger(result: ExchangeResult) {
  return {
    exchange: vi.fn(
      async (_params: {
        authScheme?: AuthScheme;
        authCredential: AuthCredential;
      }) => result,
    ),
  } satisfies BaseCredentialExchanger;
}

function fakeProvider(credential?: AuthCredential) {
  return {
    getAuthCredential: vi.fn(
      async (_authConfig: AuthConfig, _context?: unknown) => credential,
    ),
  } satisfies BaseAuthProvider;
}

function countWarnings(calls: unknown[][], fragment: string): number {
  return calls.filter(
    (call) => typeof call[0] === 'string' && call[0].includes(fragment),
  ).length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CredentialManager.registerAuthProvider', () => {
  it('serves the scheme type it was registered for', async () => {
    const credential = apiKeyCredential('from-provider');
    CredentialManager.registerAuthProvider(
      'scheme_registered',
      fakeProvider(credential),
    );
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: customAuthScheme('scheme_registered'),
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext(),
    );

    expect(result).toBe(credential);
  });

  it('warns once when a different provider claims a taken scheme type', () => {
    const warn = vi.spyOn(logger, 'warn');
    const first = fakeProvider(apiKeyCredential('first'));
    const second = fakeProvider(apiKeyCredential('second'));

    CredentialManager.registerAuthProvider('scheme_collision', first);
    CredentialManager.registerAuthProvider('scheme_collision', first);
    expect(countWarnings(warn.mock.calls, 'already registered')).toBe(0);

    CredentialManager.registerAuthProvider('scheme_collision', second);

    expect(countWarnings(warn.mock.calls, 'already registered')).toBe(1);
  });

  it('keeps serving the first provider after a collision', async () => {
    const first = fakeProvider(apiKeyCredential('winner'));
    const second = fakeProvider(apiKeyCredential('loser'));
    CredentialManager.registerAuthProvider('scheme_first_wins', first);
    CredentialManager.registerAuthProvider('scheme_first_wins', second);
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: customAuthScheme('scheme_first_wins'),
    };

    await new CredentialManager(authConfig).getAuthCredential(makeContext());

    expect(first.getAuthCredential).toHaveBeenCalledTimes(1);
    expect(second.getAuthCredential).not.toHaveBeenCalled();
  });
});

describe('CredentialManager custom scheme resolution', () => {
  it('hands the scheme to the provider with its extra fields intact', async () => {
    const provider = fakeProvider(apiKeyCredential());
    CredentialManager.registerAuthProvider('scheme_extra_fields', provider);
    const authScheme = customAuthScheme('scheme_extra_fields', {
      region: 'eu-west-1',
      audience: ['a', 'b'],
    });
    const authConfig: AuthConfig = {credentialKey: 'k', authScheme};
    const context = makeContext();

    await new CredentialManager(authConfig).getAuthCredential(context);

    expect(provider.getAuthCredential).toHaveBeenCalledWith(
      authConfig,
      context,
    );
    expect(provider.getAuthCredential.mock.calls[0][0].authScheme).toEqual(
      customAuthScheme('scheme_extra_fields', {
        region: 'eu-west-1',
        audience: ['a', 'b'],
      }),
    );
  });

  it('rejects when the provider returns nothing', async () => {
    CredentialManager.registerAuthProvider(
      'scheme_empty_provider',
      fakeProvider(undefined),
    );
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: customAuthScheme('scheme_empty_provider'),
    };

    await expect(
      new CredentialManager(authConfig).getAuthCredential(makeContext()),
    ).rejects.toThrow('AuthProvider did not return a credential.');
  });

  it('returns undefined and records the credential when consent is pending', async () => {
    const pending = oauth2Credential({authUri: 'https://example.com/consent'});
    CredentialManager.registerAuthProvider(
      'scheme_consent',
      fakeProvider(pending),
    );
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: customAuthScheme('scheme_consent'),
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext(),
    );

    expect(result).toBeUndefined();
    expect(authConfig.exchangedAuthCredential).toBe(pending);
  });

  it('returns the credential when the provider already has an access token', async () => {
    const ready = oauth2Credential({
      authUri: 'https://example.com/consent',
      accessToken: 'provider-token',
    });
    CredentialManager.registerAuthProvider(
      'scheme_provider_token',
      fakeProvider(ready),
    );
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: customAuthScheme('scheme_provider_token'),
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext(),
    );

    expect(result).toBe(ready);
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('rejects when no provider serves the custom scheme', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: customAuthScheme('scheme_unregistered'),
    };

    await expect(
      new CredentialManager(authConfig).getAuthCredential(makeContext()),
    ).rejects.toThrow(
      "No auth provider registered for custom auth scheme 'scheme_unregistered'.",
    );
  });

  it('never consults the provider registry for an OpenAPI scheme', async () => {
    const provider = fakeProvider(apiKeyCredential('from-provider'));
    CredentialManager.registerAuthProvider('apiKey', provider);
    const raw = apiKeyCredential('raw-key');
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: apiKeyScheme(),
      rawAuthCredential: raw,
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext(),
    );

    expect(provider.getAuthCredential).not.toHaveBeenCalled();
    expect(result).toEqual(raw);
  });
});

describe('CredentialManager.requestCredential', () => {
  it('asks the context for the credential', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: apiKeyScheme(),
      rawAuthCredential: apiKeyCredential(),
    };
    const context = makeContext();

    await new CredentialManager(authConfig).requestCredential(context);

    expect(context.actions.requestedAuthConfigs['call-1']).toBe(authConfig);
  });
});

describe('CredentialManager.getAuthCredential workflow', () => {
  it('returns a copy of a ready raw credential', async () => {
    const raw = apiKeyCredential('shared-key');
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: apiKeyScheme(),
      rawAuthCredential: raw,
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext(),
    );

    if (!result) {
      expect.fail('expected a credential');
    }
    expect(result).toEqual(raw);
    result.apiKey = 'mutated';
    expect(raw.apiKey).toBe('shared-key');
  });

  it('exchanges an auth response and saves the result', async () => {
    const exchanged = apiKeyCredential('exchanged');
    const service = fakeCredentialService(undefined);
    const authConfig: AuthConfig = {
      credentialKey: 'shared',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
    };
    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(
      AuthCredentialTypes.OAUTH2,
      fakeExchanger({credential: exchanged, wasExchanged: true}),
    );

    const result = await manager.getAuthCredential(
      makeContext({
        credentialService: service,
        state: {'temp:shared': oauth2Credential({authCode: 'code'})},
      }),
    );

    expect(result).toBe(exchanged);
    expect(service.saveCredential).toHaveBeenCalledTimes(1);
    const [savedConfig] = service.saveCredential.mock.calls[0];
    expect(savedConfig.credentialKey).toBe('shared');
    expect(savedConfig.exchangedAuthCredential).toBe(exchanged);
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('returns undefined when nothing can produce a credential', async () => {
    const service = fakeCredentialService(undefined);
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext({credentialService: service}),
    );

    expect(result).toBeUndefined();
    expect(service.saveCredential).not.toHaveBeenCalled();
  });

  it('falls back to a copy of the raw credential on a client credentials flow', async () => {
    const raw = oauth2Credential({clientId: 'id', clientSecret: 'secret'});
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: clientCredentialsScheme(),
      rawAuthCredential: raw,
    };
    const manager = new CredentialManager(authConfig);
    const exchanger = fakeExchanger({
      credential: apiKeyCredential('minted'),
      wasExchanged: true,
    });
    manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, exchanger);

    await manager.getAuthCredential(makeContext());

    const handed = exchanger.exchange.mock.calls[0][0].authCredential;
    expect(handed).toEqual(raw);
    expect(handed).not.toBe(raw);
  });

  it('skips the credential store for a service account', async () => {
    const service = fakeCredentialService(apiKeyCredential('stored'));
    const exchanged = apiKeyCredential('sa-token');
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: clientCredentialsScheme(),
      rawAuthCredential: {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      },
    };
    const manager = new CredentialManager(authConfig);
    const exchanger = fakeExchanger({
      credential: exchanged,
      wasExchanged: true,
    });
    manager.registerCredentialExchanger(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      exchanger,
    );

    const result = await manager.getAuthCredential(
      makeContext({credentialService: service}),
    );

    expect(service.loadCredential).not.toHaveBeenCalled();
    expect(service.saveCredential).not.toHaveBeenCalled();
    expect(exchanger.exchange.mock.calls[0][0].authCredential.authType).toBe(
      AuthCredentialTypes.SERVICE_ACCOUNT,
    );
    expect(result).toBe(exchanged);
  });

  it('consults the credential service even when the config holds an exchanged credential', async () => {
    const stored = apiKeyCredential('stored');
    const service = fakeCredentialService(stored);
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
      exchangedAuthCredential: apiKeyCredential('stale-cache'),
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext({credentialService: service}),
    );

    expect(service.loadCredential).toHaveBeenCalledTimes(1);
    expect(result).toBe(stored);
  });

  it('passes the auth config and context to the credential service', async () => {
    const service = fakeCredentialService(apiKeyCredential('stored'));
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
    };
    const context = makeContext({
      credentialService: service,
      state: {'temp:k': apiKeyCredential('from-response')},
    });

    const result = await new CredentialManager(authConfig).getAuthCredential(
      context,
    );

    expect(service.loadCredential).toHaveBeenCalledWith(authConfig, context);
    expect(result).toEqual(apiKeyCredential('stored'));
  });

  it('falls through to the auth response when there is no credential service', async () => {
    const fromResponse = apiKeyCredential('from-response');
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext({state: {'temp:k': fromResponse}}),
    );

    expect(result).toEqual(fromResponse);
  });

  it('does not leak one user token into another user request', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'shared',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({
        clientId: 'mock_client_id',
        clientSecret: 'mock_client_secret',
      }),
    };
    const manager = new CredentialManager(authConfig);
    const contextA = makeContext({
      sessionId: 'session-a',
      userId: 'user-a',
      functionCallId: 'call-a',
      state: {
        'temp:shared': oauth2Credential({
          authUri: 'https://example.com/authorize?x=y',
          state: 'state_a',
          accessToken: 'token_a',
          expiresAt: Date.now() + 3_600_000,
        }),
      },
    });
    const contextB = makeContext({
      sessionId: 'session-b',
      userId: 'user-b',
      functionCallId: 'call-b',
    });

    await manager.getAuthCredential(contextA);
    await manager.requestCredential(contextB);

    const requested = contextB.actions.requestedAuthConfigs['call-b'];
    expect(
      requested.exchangedAuthCredential?.oauth2?.accessToken,
    ).toBeUndefined();
  });
});

describe('CredentialManager default registrations', () => {
  it('reaches the OAuth2 exchanger for an OAuth2 credential', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: clientCredentialsScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id'}),
    };

    await expect(
      new CredentialManager(authConfig).getAuthCredential(makeContext()),
    ).rejects.toThrow(
      'clientId and clientSecret are required for client credentials exchange.',
    );
  });

  it('reaches the service account exchanger for a service account credential', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: clientCredentialsScheme(),
      rawAuthCredential: {authType: AuthCredentialTypes.SERVICE_ACCOUNT},
    };

    await expect(
      new CredentialManager(authConfig).getAuthCredential(makeContext()),
    ).rejects.toThrow(
      'Invalid credential type for ServiceAccountCredentialExchanger',
    );
  });

  it('persists a credential the OAuth2 refresher reports as expired', async () => {
    const service = fakeCredentialService(
      oauth2Credential({
        clientId: 'id',
        clientSecret: 's',
        accessToken: 'stale',
        expiresAt: 1,
      }),
    );
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
    };

    await new CredentialManager(authConfig).getAuthCredential(
      makeContext({credentialService: service}),
    );

    expect(service.saveCredential).toHaveBeenCalledTimes(1);
  });

  it('passes the credential and the scheme to the refresher', async () => {
    const refreshed = oauth2Credential({accessToken: 'fresh'});
    const stored = oauth2Credential({
      clientId: 'id',
      clientSecret: 'secret',
      accessToken: 'stale',
      expiresAt: 1,
    });
    const service = fakeCredentialService(stored);
    const authScheme = authorizationCodeScheme();
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme,
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
    };
    const refresh = vi
      .spyOn(OAuth2CredentialRefresher.prototype, 'refresh')
      .mockResolvedValue(refreshed);

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext({credentialService: service}),
    );

    expect(refresh).toHaveBeenCalledWith(stored, authScheme);
    expect(result).toBe(refreshed);
  });

  it('leaves a credential with no exchanger and no refresher untouched', async () => {
    const stored = apiKeyCredential('stored');
    const service = fakeCredentialService(stored);
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
    };

    const result = await new CredentialManager(authConfig).getAuthCredential(
      makeContext({credentialService: service}),
    );

    expect(result).toBe(stored);
    expect(service.saveCredential).not.toHaveBeenCalled();
  });

  it('does not refresh a credential that was just exchanged', async () => {
    const exchanged = oauth2Credential({accessToken: 'fresh', expiresAt: 1});
    const service = fakeCredentialService(
      oauth2Credential({clientId: 'id', clientSecret: 's', expiresAt: 1}),
    );
    const authConfig: AuthConfig = {
      credentialKey: 'k',
      authScheme: authorizationCodeScheme(),
      rawAuthCredential: oauth2Credential({clientId: 'id', clientSecret: 's'}),
    };
    const manager = new CredentialManager(authConfig);
    manager.registerCredentialExchanger(
      AuthCredentialTypes.OAUTH2,
      fakeExchanger({credential: exchanged, wasExchanged: true}),
    );
    const refresh = vi.spyOn(OAuth2CredentialRefresher.prototype, 'refresh');

    const result = await manager.getAuthCredential(
      makeContext({credentialService: service}),
    );

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toBe(exchanged);
  });
});

describe('isCredentialReady', () => {
  it('accepts an API key credential', () => {
    expect(isCredentialReady(apiKeyCredential())).toBe(true);
  });

  it('accepts an HTTP credential', () => {
    expect(
      isCredentialReady({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 't'}},
      }),
    ).toBe(true);
  });

  it('rejects an OAuth2 credential', () => {
    expect(isCredentialReady(oauth2Credential({clientId: 'id'}))).toBe(false);
  });

  it('rejects a missing credential', () => {
    expect(isCredentialReady(undefined)).toBe(false);
  });
});

describe('isClientCredentialsFlow', () => {
  it('accepts an OAuth2 scheme with a client credentials flow', () => {
    expect(isClientCredentialsFlow(clientCredentialsScheme())).toBe(true);
  });

  it('rejects an OAuth2 scheme without one', () => {
    expect(isClientCredentialsFlow(authorizationCodeScheme())).toBe(false);
  });

  it('rejects an OAuth2 scheme with no flows at all', () => {
    expect(isClientCredentialsFlow(customAuthScheme('oauth2'))).toBe(false);
  });

  it('accepts an OIDC scheme listing the client credentials grant', () => {
    expect(isClientCredentialsFlow(oidcScheme(['client_credentials']))).toBe(
      true,
    );
  });

  it('rejects an OIDC scheme without the grant', () => {
    expect(isClientCredentialsFlow(oidcScheme(['authorization_code']))).toBe(
      false,
    );
  });

  it('rejects an OIDC scheme declaring no grants', () => {
    expect(isClientCredentialsFlow(oidcScheme())).toBe(false);
  });

  it('rejects an unrelated scheme', () => {
    expect(isClientCredentialsFlow(apiKeyScheme())).toBe(false);
  });
});

describe('missingOAuthInfo', () => {
  it('rejects a non-OAuth2 scheme', () => {
    expect(missingOAuthInfo(apiKeyScheme())).toBe(false);
  });

  it('rejects an OAuth2 scheme with no flows', () => {
    expect(missingOAuthInfo(customAuthScheme('oauth2'))).toBe(false);
  });

  it('accepts an implicit flow with no authorization URL', () => {
    expect(
      missingOAuthInfo({
        type: 'oauth2',
        flows: {implicit: {authorizationUrl: '', scopes: {}}},
      }),
    ).toBe(true);
  });

  it('accepts a password flow with no token URL', () => {
    expect(
      missingOAuthInfo({
        type: 'oauth2',
        flows: {password: {tokenUrl: '', scopes: {}}},
      }),
    ).toBe(true);
  });

  it('accepts a client credentials flow with no token URL', () => {
    expect(
      missingOAuthInfo({
        type: 'oauth2',
        flows: {clientCredentials: {tokenUrl: '', scopes: {}}},
      }),
    ).toBe(true);
  });

  it('accepts an authorization code flow with no authorization URL', () => {
    expect(
      missingOAuthInfo(
        authorizationCodeScheme('', 'https://example.com/token'),
      ),
    ).toBe(true);
  });

  it('accepts an authorization code flow with no token URL', () => {
    expect(
      missingOAuthInfo(
        authorizationCodeScheme('https://example.com/authorize', ''),
      ),
    ).toBe(true);
  });

  it('rejects a fully populated scheme', () => {
    expect(missingOAuthInfo(authorizationCodeScheme())).toBe(false);
  });
});

describe('populateAuthScheme', () => {
  it('fills both authorization code endpoints and reports success', async () => {
    const scheme = discoverableScheme();
    const discovery = new OAuth2DiscoveryManager();
    vi.spyOn(discovery, 'discoverAuthServerMetadata').mockResolvedValue(
      serverMetadata(),
    );

    expect(await populateAuthScheme(scheme, discovery)).toBe(true);

    expect(flowsOf(scheme).authorizationCode?.authorizationUrl).toBe(
      'https://auth.example.com/authorize',
    );
    expect(flowsOf(scheme).authorizationCode?.tokenUrl).toBe(
      'https://auth.example.com/token',
    );
  });

  it('fills the implicit, password and client credentials endpoints', async () => {
    const scheme: ExtendedOAuth2 = {
      type: 'oauth2',
      issuerUrl: 'https://auth.example.com',
      flows: {
        implicit: {authorizationUrl: '', scopes: {}},
        password: {tokenUrl: '', scopes: {}},
        clientCredentials: {tokenUrl: '', scopes: {}},
      },
    };
    const discovery = new OAuth2DiscoveryManager();
    vi.spyOn(discovery, 'discoverAuthServerMetadata').mockResolvedValue(
      serverMetadata(),
    );

    expect(await populateAuthScheme(scheme, discovery)).toBe(true);

    expect(flowsOf(scheme).implicit?.authorizationUrl).toBe(
      'https://auth.example.com/authorize',
    );
    expect(flowsOf(scheme).password?.tokenUrl).toBe(
      'https://auth.example.com/token',
    );
    expect(flowsOf(scheme).clientCredentials?.tokenUrl).toBe(
      'https://auth.example.com/token',
    );
  });

  it('leaves an endpoint that is already set', async () => {
    const scheme: ExtendedOAuth2 = {
      type: 'oauth2',
      issuerUrl: 'https://auth.example.com',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://keep.example.com/authorize',
          tokenUrl: 'https://keep.example.com/token',
          scopes: {},
        },
      },
    };
    const discovery = new OAuth2DiscoveryManager();
    vi.spyOn(discovery, 'discoverAuthServerMetadata').mockResolvedValue(
      serverMetadata(),
    );

    expect(await populateAuthScheme(scheme, discovery)).toBe(true);

    expect(flowsOf(scheme).authorizationCode?.authorizationUrl).toBe(
      'https://keep.example.com/authorize',
    );
    expect(flowsOf(scheme).authorizationCode?.tokenUrl).toBe(
      'https://keep.example.com/token',
    );
  });

  it('reports failure and changes nothing when discovery finds no metadata', async () => {
    const scheme = discoverableScheme();
    const discovery = new OAuth2DiscoveryManager();
    vi.spyOn(discovery, 'discoverAuthServerMetadata').mockResolvedValue(
      undefined,
    );
    const warn = vi.spyOn(logger, 'warn');

    expect(await populateAuthScheme(scheme, discovery)).toBe(false);

    expect(flowsOf(scheme).authorizationCode?.authorizationUrl).toBe('');
    expect(flowsOf(scheme).authorizationCode?.tokenUrl).toBe('');
    expect(countWarnings(warn.mock.calls, 'Auto-discovery has failed')).toBe(1);
  });

  it('reports failure without calling discovery when the issuer is absent', async () => {
    const discovery = new OAuth2DiscoveryManager();
    const discover = vi.spyOn(discovery, 'discoverAuthServerMetadata');
    const warn = vi.spyOn(logger, 'warn');

    expect(await populateAuthScheme(authorizationCodeScheme(), discovery)).toBe(
      false,
    );

    expect(discover).not.toHaveBeenCalled();
    expect(countWarnings(warn.mock.calls, 'No issuerUrl')).toBe(1);
  });

  it('reports failure for a scheme that is not OAuth2', async () => {
    const discovery = new OAuth2DiscoveryManager();
    const discover = vi.spyOn(discovery, 'discoverAuthServerMetadata');

    expect(await populateAuthScheme(apiKeyScheme(), discovery)).toBe(false);

    expect(discover).not.toHaveBeenCalled();
  });
});

describe('validateCredential', () => {
  const discovery = new OAuth2DiscoveryManager();

  it('rejects an OAuth2 scheme with no raw credential', async () => {
    await expect(
      validateCredential(
        {credentialKey: 'k', authScheme: authorizationCodeScheme()},
        discovery,
      ),
    ).rejects.toThrow(
      'rawAuthCredential is required for auth scheme type oauth2',
    );
  });

  it('rejects an OIDC scheme with no raw credential', async () => {
    await expect(
      validateCredential(
        {credentialKey: 'k', authScheme: oidcScheme()},
        discovery,
      ),
    ).rejects.toThrow(
      'rawAuthCredential is required for auth scheme type openIdConnect',
    );
  });

  it('accepts another scheme with no raw credential', async () => {
    await expect(
      validateCredential(
        {credentialKey: 'k', authScheme: apiKeyScheme()},
        discovery,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects an OAuth2 credential with no oauth2 block', async () => {
    await expect(
      validateCredential(
        {
          credentialKey: 'k',
          authScheme: authorizationCodeScheme(),
          rawAuthCredential: {authType: AuthCredentialTypes.OAUTH2},
        },
        discovery,
      ),
    ).rejects.toThrow(
      'authConfig.rawAuthCredential.oauth2 is required for credential type oauth2',
    );
  });

  it('rejects when auto-discovery cannot fill the missing endpoints', async () => {
    const failing = new OAuth2DiscoveryManager();
    vi.spyOn(failing, 'discoverAuthServerMetadata').mockResolvedValue(
      undefined,
    );

    await expect(
      validateCredential(
        {
          credentialKey: 'k',
          authScheme: discoverableScheme(),
          rawAuthCredential: oauth2Credential({clientId: 'id'}),
        },
        failing,
      ),
    ).rejects.toThrow(
      'OAuth scheme info is missing, and auto-discovery has failed to fill them in.',
    );
  });

  it('accepts a scheme once auto-discovery fills the endpoints', async () => {
    const succeeding = new OAuth2DiscoveryManager();
    vi.spyOn(succeeding, 'discoverAuthServerMetadata').mockResolvedValue(
      serverMetadata(),
    );

    await expect(
      validateCredential(
        {
          credentialKey: 'k',
          authScheme: discoverableScheme(),
          rawAuthCredential: oauth2Credential({clientId: 'id'}),
        },
        succeeding,
      ),
    ).resolves.toBeUndefined();
  });
});
