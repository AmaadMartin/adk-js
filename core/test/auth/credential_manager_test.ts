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
  createSession,
  CredentialExchangeError,
  CredentialManager,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, Mock, vi} from 'vitest';

const CREDENTIAL_KEY = 'documents_api';
const TOKEN_URL = 'https://provider.example.com/token';

/** `OAuth2Auth.expiresAt` is a millisecond timestamp in adk-js. */
const ONE_HOUR_MS = 60 * 60 * 1000;

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'raw-api-key',
};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const OAUTH2_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
};

function authorizationCodeScheme(): AuthScheme {
  return {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://provider.example.com/authorize',
        tokenUrl: TOKEN_URL,
        scopes: {'documents.read': 'Read your documents'},
      },
    },
  };
}

function clientCredentialsScheme(): AuthScheme {
  return {
    type: 'oauth2',
    flows: {
      clientCredentials: {
        tokenUrl: TOKEN_URL,
        scopes: {'documents.read': 'Read your documents'},
      },
    },
  };
}

/**
 * Answers the OAuth2 token endpoint with `accessToken`, so the real exchanger
 * and refresher run without a provider.
 */
function stubTokenEndpoint(accessToken: string): Mock {
  const fetchStub = vi.fn(async () =>
    Response.json({access_token: accessToken, expires_in: 3600}),
  );
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

/** Records what the manager loads and saves, without a real backend. */
class RecordingCredentialService implements BaseCredentialService {
  readonly saved: AuthConfig[] = [];
  loadCalls = 0;

  constructor(private readonly stored?: AuthCredential) {}

  async loadCredential(): Promise<AuthCredential | undefined> {
    this.loadCalls++;
    return this.stored;
  }

  async saveCredential(authConfig: AuthConfig): Promise<void> {
    this.saved.push(authConfig);
  }
}

function createContext(options?: {
  credentialService?: BaseCredentialService;
  state?: Record<string, unknown>;
  functionCallId?: string;
}): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'session-1',
      appName: 'test_app',
      userId: 'user_1',
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

describe('CredentialManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('credentials that are ready to use', () => {
    it('returns a raw API key credential without consulting the service', async () => {
      const credentialService = new RecordingCredentialService();
      const authConfig: AuthConfig = {
        authScheme: API_KEY_SCHEME,
        rawAuthCredential: API_KEY_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createContext({credentialService}));

      expect(credential).toEqual(API_KEY_CREDENTIAL);
      expect(credentialService.loadCalls).toBe(0);
      expect(credentialService.saved).toHaveLength(0);
    });

    it('returns a copy, so a caller cannot mutate the shared config', async () => {
      const authConfig: AuthConfig = {
        authScheme: API_KEY_SCHEME,
        rawAuthCredential: {...API_KEY_CREDENTIAL},
        credentialKey: CREDENTIAL_KEY,
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createContext());

      if (!credential) {
        expect.fail('no credential was resolved');
      }
      expect(credential).not.toBe(authConfig.rawAuthCredential);
      credential.apiKey = 'tampered';
      expect(authConfig.rawAuthCredential?.apiKey).toBe('raw-api-key');
    });

    it('returns a raw HTTP credential as is', async () => {
      const httpCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'token-value'}},
      };
      const authConfig: AuthConfig = {
        authScheme: {type: 'http', scheme: 'bearer'},
        rawAuthCredential: httpCredential,
        credentialKey: CREDENTIAL_KEY,
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createContext());

      expect(credential).toEqual(httpCredential);
    });
  });

  describe('configuration validation', () => {
    it('rejects an oauth2 scheme with no raw credential', async () => {
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        credentialKey: CREDENTIAL_KEY,
      });

      await expect(manager.getAuthCredential(createContext())).rejects.toThrow(
        'rawAuthCredential is required for authScheme type oauth2.',
      );
    });

    it('rejects an OAUTH2 credential with no oauth2 field', async () => {
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: {authType: AuthCredentialTypes.OAUTH2},
        credentialKey: CREDENTIAL_KEY,
      });

      await expect(manager.getAuthCredential(createContext())).rejects.toThrow(
        'rawAuthCredential.oauth2 is required for credential type oauth2.',
      );
    });

    const incompleteFlows: Array<{
      name: string;
      flows: OpenAPIV3.OAuth2SecurityScheme['flows'];
    }> = [
      {
        name: 'implicit.authorizationUrl',
        flows: {implicit: {authorizationUrl: '', scopes: {}}},
      },
      {
        name: 'password.tokenUrl',
        flows: {password: {tokenUrl: '', scopes: {}}},
      },
      {
        name: 'clientCredentials.tokenUrl',
        flows: {clientCredentials: {tokenUrl: '', scopes: {}}},
      },
      {
        name: 'authorizationCode.authorizationUrl',
        flows: {
          authorizationCode: {
            authorizationUrl: '',
            tokenUrl: 'https://provider.example.com/token',
            scopes: {},
          },
        },
      },
      {
        name: 'authorizationCode.tokenUrl',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://provider.example.com/authorize',
            tokenUrl: '',
            scopes: {},
          },
        },
      },
    ];

    for (const {name, flows} of incompleteFlows) {
      it(`rejects an oauth2 scheme missing ${name}`, async () => {
        const manager = new CredentialManager({
          authScheme: {type: 'oauth2', flows},
          rawAuthCredential: OAUTH2_CREDENTIAL,
          credentialKey: CREDENTIAL_KEY,
        });

        await expect(
          manager.getAuthCredential(createContext()),
        ).rejects.toThrow(`The OAuth scheme is missing ${name}.`);
      });
    }
  });

  describe('loading a stored credential', () => {
    it('returns the stored credential and saves nothing', async () => {
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'stored-access-token'},
      };
      const credentialService = new RecordingCredentialService(stored);
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({credentialService}),
      );

      expect(credential).toEqual(stored);
      expect(credentialService.saved).toHaveLength(0);
    });

    it('loads the auth response from session state and saves it', async () => {
      const fromAuthResponse: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'granted-access-token'},
      };
      const credentialService = new RecordingCredentialService();
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({
          credentialService,
          state: {[`temp:${CREDENTIAL_KEY}`]: fromAuthResponse},
        }),
      );

      expect(credential).toEqual(fromAuthResponse);
      expect(credentialService.saved).toHaveLength(1);
      expect(credentialService.saved[0].exchangedAuthCredential).toEqual(
        fromAuthResponse,
      );
      expect(credentialService.saved[0].credentialKey).toBe(CREDENTIAL_KEY);
    });

    it('resolves without a credential service', async () => {
      const fromAuthResponse: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'granted-access-token'},
      };
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({state: {[`temp:${CREDENTIAL_KEY}`]: fromAuthResponse}}),
      );

      expect(credential).toEqual(fromAuthResponse);
    });

    it('returns undefined when an authorization code flow has nothing stored', async () => {
      const credentialService = new RecordingCredentialService();
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({credentialService}),
      );

      expect(credential).toBeUndefined();
      expect(credentialService.saved).toHaveLength(0);
    });
  });

  describe('exchange and refresh', () => {
    it('exchanges a client credentials flow without mutating the raw credential', async () => {
      const fetchStub = stubTokenEndpoint('exchanged-access-token');
      const credentialService = new RecordingCredentialService();
      const authConfig: AuthConfig = {
        authScheme: clientCredentialsScheme(),
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
        },
        credentialKey: CREDENTIAL_KEY,
      };

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(createContext({credentialService}));

      expect(credential?.oauth2?.accessToken).toBe('exchanged-access-token');
      // One call: the exchange. A refresh would be a second one.
      expect(fetchStub).toHaveBeenCalledOnce();
      expect(fetchStub.mock.calls[0][0]).toBe(TOKEN_URL);
      expect(credentialService.saved).toHaveLength(1);
      expect(authConfig.rawAuthCredential?.oauth2?.accessToken).toBeUndefined();
    });

    it('refreshes a stored credential that has expired', async () => {
      const fetchStub = stubTokenEndpoint('refreshed-access-token');
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          accessToken: 'expired-access-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - ONE_HOUR_MS,
        },
      };
      const credentialService = new RecordingCredentialService(stored);
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({credentialService}),
      );

      expect(credential?.oauth2?.accessToken).toBe('refreshed-access-token');
      expect(fetchStub).toHaveBeenCalledOnce();
      expect(credentialService.saved).toHaveLength(1);
      expect(
        credentialService.saved[0].exchangedAuthCredential?.oauth2?.accessToken,
      ).toBe('refreshed-access-token');
    });

    it('does not save a client credential the exchanger left alone', async () => {
      const fetchStub = stubTokenEndpoint('unexpected-access-token');
      const credentialService = new RecordingCredentialService();
      // The exchanger returns early on a credential that already has a token,
      // so nothing here was obtained on the user's behalf. Saving would put the
      // configured client id and secret into the credential store.
      const manager = new CredentialManager({
        authScheme: clientCredentialsScheme(),
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            accessToken: 'configured-access-token',
          },
        },
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({credentialService}),
      );

      expect(credential?.oauth2?.accessToken).toBe('configured-access-token');
      expect(fetchStub).not.toHaveBeenCalled();
      expect(credentialService.saved).toHaveLength(0);
    });

    it('saves nothing when the credential needs no refresh', async () => {
      const fetchStub = stubTokenEndpoint('unexpected-access-token');
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          accessToken: 'stored-access-token',
          expiresAt: Date.now() + ONE_HOUR_MS,
        },
      };
      const credentialService = new RecordingCredentialService(stored);
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({credentialService}),
      );

      expect(credential).toEqual(stored);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(credentialService.saved).toHaveLength(0);
    });

    it('leaves a credential type with no registered exchanger untouched', async () => {
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'stored-api-key',
      };
      const credentialService = new RecordingCredentialService(stored);
      const manager = new CredentialManager({
        authScheme: API_KEY_SCHEME,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({credentialService}),
      );

      expect(credential).toEqual(stored);
      expect(credentialService.saved).toHaveLength(0);
    });

    it('routes a service account credential to the default exchanger', async () => {
      const manager = new CredentialManager({
        authScheme: clientCredentialsScheme(),
        rawAuthCredential: {
          authType: AuthCredentialTypes.SERVICE_ACCOUNT,
          oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
        },
        credentialKey: CREDENTIAL_KEY,
      });

      await expect(manager.getAuthCredential(createContext())).rejects.toThrow(
        CredentialExchangeError,
      );
    });

    it('uses the default OAuth2 refresher, which reports no refresh for a live token', async () => {
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          accessToken: 'live-access-token',
          expiresAt: Date.now() + ONE_HOUR_MS,
        },
      };
      const credentialService = new RecordingCredentialService(stored);
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({credentialService}),
      );

      expect(credential).toEqual(stored);
      expect(credentialService.saved).toHaveLength(0);
    });

    it('uses the default OAuth2 refresher, which saves an expired token it cannot renew', async () => {
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          accessToken: 'expired-access-token',
          expiresAt: Date.now() - ONE_HOUR_MS,
        },
      };
      const credentialService = new RecordingCredentialService(stored);
      const manager = new CredentialManager({
        authScheme: authorizationCodeScheme(),
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(
        createContext({credentialService}),
      );

      expect(credential).toEqual(stored);
      expect(credentialService.saved).toHaveLength(1);
    });
  });

  describe('OpenID Connect schemes', () => {
    const OIDC_CREDENTIAL: AuthCredential = {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };

    function oidcScheme(grantTypesSupported?: string[]): AuthScheme {
      return {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://provider.example.com/.well-known/openid-configuration',
        authorizationEndpoint: 'https://provider.example.com/authorize',
        tokenEndpoint: TOKEN_URL,
        grantTypesSupported,
      };
    }

    it('exchanges the raw credential when client_credentials is supported', async () => {
      const fetchStub = stubTokenEndpoint('exchanged-access-token');
      const manager = new CredentialManager({
        authScheme: oidcScheme(['authorization_code', 'client_credentials']),
        rawAuthCredential: OIDC_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(createContext());

      expect(credential?.oauth2?.accessToken).toBe('exchanged-access-token');
      expect(fetchStub.mock.calls[0][0]).toBe(TOKEN_URL);
    });

    it('waits for consent when client_credentials is not supported', async () => {
      const manager = new CredentialManager({
        authScheme: oidcScheme(['authorization_code']),
        rawAuthCredential: OIDC_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(createContext());

      expect(credential).toBeUndefined();
    });

    it('waits for consent when the grant type list is undefined', async () => {
      const manager = new CredentialManager({
        authScheme: oidcScheme(),
        rawAuthCredential: OIDC_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(createContext());

      expect(credential).toBeUndefined();
    });

    it('waits for consent when the scheme declares no grant types', async () => {
      const manager = new CredentialManager({
        authScheme: {
          type: 'openIdConnect',
          openIdConnectUrl:
            'https://provider.example.com/.well-known/openid-configuration',
        },
        rawAuthCredential: OIDC_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      });

      const credential = await manager.getAuthCredential(createContext());

      expect(credential).toBeUndefined();
    });
  });

  describe('requestCredential', () => {
    it('parks the auth config on the waiting function call', () => {
      const authConfig: AuthConfig = {
        authScheme: API_KEY_SCHEME,
        rawAuthCredential: API_KEY_CREDENTIAL,
        credentialKey: CREDENTIAL_KEY,
      };
      const context = createContext({functionCallId: 'call_1'});

      new CredentialManager(authConfig).requestCredential(context);

      expect(context.eventActions.requestedAuthConfigs['call_1']).toEqual(
        authConfig,
      );
    });
  });
});
