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
  InMemoryCredentialService,
  InvocationContext,
  LlmAgent,
  OpenIdConnectWithConfig,
  PluginManager,
  createSession,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const CREDENTIAL_KEY = 'test-credential-key';
const FUNCTION_CALL_ID = 'fc-1';
const TOKEN_ENDPOINT = 'https://oauth.example.com/token';

const apiKeyScheme: AuthScheme = {
  type: 'apiKey',
  name: 'X-Api-Key',
  in: 'header',
};

const authorizationCodeScheme: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://oauth.example.com/auth',
      tokenUrl: TOKEN_ENDPOINT,
      scopes: {},
    },
  },
};

const clientCredentialsScheme: AuthScheme = {
  type: 'oauth2',
  flows: {
    clientCredentials: {tokenUrl: TOKEN_ENDPOINT, scopes: {}},
  },
};

const oidcClientCredentialsScheme: OpenIdConnectWithConfig = {
  type: 'openIdConnect',
  openIdConnectUrl:
    'https://oauth.example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://oauth.example.com/auth',
  tokenEndpoint: TOKEN_ENDPOINT,
  grantTypesSupported: ['client_credentials'],
};

const oidcAuthorizationCodeScheme: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl:
    'https://oauth.example.com/.well-known/openid-configuration',
};

function createInvocationContext(
  credentialService?: BaseCredentialService,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    credentialService,
  });
}

function createToolContext(credentialService?: BaseCredentialService): Context {
  return new Context({
    invocationContext: createInvocationContext(credentialService),
    functionCallId: FUNCTION_CALL_ID,
  });
}

function stubTokenEndpoint(response: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(response), {
      status: 200,
      headers: {'Content-Type': 'application/json'},
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CredentialManager', () => {
  describe('getAuthCredential', () => {
    it('returns a deep copy of a ready API key credential', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: apiKeyScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'test-api-key',
        },
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createToolContext());

      expect(credential).toEqual(authConfig.rawAuthCredential);
      expect(credential).not.toBe(authConfig.rawAuthCredential);
    });

    it('returns a deep copy of a ready HTTP credential', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: apiKeyScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'test-token'}},
        },
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createToolContext());

      expect(credential?.http?.credentials.token).toBe('test-token');
      // Nested objects are copied too, so a caller cannot mutate the shared
      // auth config through the returned credential.
      credential!.http!.credentials.token = 'mutated';
      expect(authConfig.rawAuthCredential?.http?.credentials.token).toBe(
        'test-token',
      );
    });

    it('returns the credential held by the credential service', async () => {
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'stored-api-key',
      };
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: apiKeyScheme,
      };
      const credentialService = new InMemoryCredentialService();
      const context = createToolContext(credentialService);
      await credentialService.saveCredential(
        {...authConfig, exchangedAuthCredential: stored},
        context,
      );
      const getAuthResponse = vi.spyOn(context, 'getAuthResponse');

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(context);

      expect(credential).toEqual(stored);
      expect(getAuthResponse).not.toHaveBeenCalled();
    });

    it('saves a credential taken from the auth response', async () => {
      const fromClient: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'client-supplied-api-key',
      };
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: apiKeyScheme,
      };
      const credentialService = new InMemoryCredentialService();
      const context = createToolContext(credentialService);
      context.state.set(`temp:${CREDENTIAL_KEY}`, fromClient);

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(context);

      expect(credential).toEqual(fromClient);
      expect(
        await credentialService.loadCredential(authConfig, context),
      ).toEqual(fromClient);
    });

    it('resolves without a credential service', async () => {
      const fromClient: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'client-supplied-api-key',
      };
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: apiKeyScheme,
      };
      const context = createToolContext();
      context.state.set(`temp:${CREDENTIAL_KEY}`, fromClient);

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(context);

      expect(credential).toEqual(fromClient);
    });

    it('returns undefined and saves nothing for an authorization code flow with no stored credential', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: authorizationCodeScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'test-client-id', clientSecret: 'test-secret'},
        },
      };
      const credentialService = new InMemoryCredentialService();
      const context = createToolContext(credentialService);

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(context);

      expect(credential).toBeUndefined();
      expect(
        await credentialService.loadCredential(authConfig, context),
      ).toBeUndefined();
    });

    it('returns undefined for a non-OAuth scheme whose credential still needs processing', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: apiKeyScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.SERVICE_ACCOUNT,
          serviceAccount: {useDefaultCredential: true},
        },
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createToolContext());

      expect(credential).toBeUndefined();
    });

    it('returns undefined for an OpenID Connect scheme that does not support client credentials', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: oidcAuthorizationCodeScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.OPEN_ID_CONNECT,
          oauth2: {clientId: 'test-client-id', clientSecret: 'test-secret'},
        },
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createToolContext());

      expect(credential).toBeUndefined();
    });

    it('falls back to a deep copy of the raw credential for an OAuth2 client credentials flow', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: clientCredentialsScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: 'test-client-id',
            clientSecret: 'test-secret',
            accessToken: 'preconfigured-access-token',
          },
        },
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createToolContext());

      expect(credential).toEqual(authConfig.rawAuthCredential);
      credential!.oauth2!.accessToken = 'mutated';
      expect(authConfig.rawAuthCredential?.oauth2?.accessToken).toBe(
        'preconfigured-access-token',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('falls back to the raw credential for an OpenID Connect client credentials flow', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: oidcClientCredentialsScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.OPEN_ID_CONNECT,
          oauth2: {
            clientId: 'test-client-id',
            clientSecret: 'test-secret',
            accessToken: 'preconfigured-access-token',
          },
        },
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createToolContext());

      expect(credential?.oauth2?.accessToken).toBe(
        'preconfigured-access-token',
      );
    });

    it('exchanges a client credentials grant, saves it, and skips the refresher', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: clientCredentialsScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'test-client-id', clientSecret: 'test-secret'},
        },
      };
      const credentialService = new InMemoryCredentialService();
      const context = createToolContext(credentialService);
      // `expires_in: 1` makes the exchanged token immediately due for refresh,
      // so a second fetch would happen if the refresher were consulted.
      const fetchSpy = stubTokenEndpoint({
        access_token: 'exchanged-access-token',
        expires_in: 1,
      });

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(context);

      expect(credential?.oauth2?.accessToken).toBe('exchanged-access-token');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(
        (await credentialService.loadCredential(authConfig, context))?.oauth2
          ?.accessToken,
      ).toBe('exchanged-access-token');
    });

    it('refreshes an expired stored credential and saves the result', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: authorizationCodeScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'test-client-id', clientSecret: 'test-secret'},
        },
      };
      const credentialService = new InMemoryCredentialService();
      const context = createToolContext(credentialService);
      await credentialService.saveCredential(
        {
          ...authConfig,
          exchangedAuthCredential: {
            authType: AuthCredentialTypes.OAUTH2,
            oauth2: {
              clientId: 'test-client-id',
              clientSecret: 'test-secret',
              accessToken: 'expired-access-token',
              refreshToken: 'test-refresh-token',
              expiresAt: Date.now() - 1000,
            },
          },
        },
        context,
      );
      stubTokenEndpoint({
        access_token: 'refreshed-access-token',
        expires_in: 3600,
      });

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(context);

      expect(credential?.oauth2?.accessToken).toBe('refreshed-access-token');
      expect(
        (await credentialService.loadCredential(authConfig, context))?.oauth2
          ?.accessToken,
      ).toBe('refreshed-access-token');
    });

    it('keeps a stored credential that does not need refreshing', async () => {
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'test-client-id',
          clientSecret: 'test-secret',
          accessToken: 'valid-access-token',
          refreshToken: 'test-refresh-token',
          expiresAt: Date.now() + 3600_000,
        },
      };
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: authorizationCodeScheme,
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'test-client-id', clientSecret: 'test-secret'},
        },
      };
      const credentialService = new InMemoryCredentialService();
      const context = createToolContext(credentialService);
      await credentialService.saveCredential(
        {...authConfig, exchangedAuthCredential: stored},
        context,
      );
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(context);

      expect(credential).toEqual(stored);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws when an OAuth2 scheme has no raw credential', async () => {
      const manager = new CredentialManager({
        credentialKey: CREDENTIAL_KEY,
        authScheme: authorizationCodeScheme,
      });

      await expect(
        manager.getAuthCredential(createToolContext()),
      ).rejects.toThrow(
        'rawAuthCredential is required for auth scheme type oauth2',
      );
    });

    it('throws when an OAuth2 raw credential has no oauth2 payload', async () => {
      const manager = new CredentialManager({
        credentialKey: CREDENTIAL_KEY,
        authScheme: authorizationCodeScheme,
        rawAuthCredential: {authType: AuthCredentialTypes.OAUTH2},
      });

      await expect(
        manager.getAuthCredential(createToolContext()),
      ).rejects.toThrow(
        'rawAuthCredential.oauth2 is required for credential type oauth2',
      );
    });
  });

  describe('requestCredential', () => {
    it('records the auth config on the event actions', async () => {
      const authConfig: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: apiKeyScheme,
      };
      const context = createToolContext();

      await new CredentialManager(authConfig).requestCredential(context);

      expect(
        context.eventActions.requestedAuthConfigs[FUNCTION_CALL_ID],
      ).toEqual(authConfig);
    });

    it('throws when the context has no function call id', async () => {
      const manager = new CredentialManager({
        credentialKey: CREDENTIAL_KEY,
        authScheme: apiKeyScheme,
      });
      const contextWithoutFunctionCall = new Context({
        invocationContext: createInvocationContext(),
      });

      await expect(
        manager.requestCredential(contextWithoutFunctionCall),
      ).rejects.toThrow('functionCallId is not set.');
    });
  });
});
