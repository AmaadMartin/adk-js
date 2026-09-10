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
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const TOKEN_URL = 'https://provider.example.com/token';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
};
const OAUTH2_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://provider.example.com/authorize',
      tokenUrl: TOKEN_URL,
      scopes: {read: 'Read access'},
    },
  },
};
const OPEN_ID_CONNECT_SCHEME: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://provider.example.com/openid-configuration',
  authorizationEndpoint: 'https://provider.example.com/authorize',
  tokenEndpoint: TOKEN_URL,
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'configured-api-key',
};
const OAUTH2_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
};

/** An expired OAuth2 credential the real refresher can renew. */
function createExpiredCredential(
  authType:
    | AuthCredentialTypes.OAUTH2
    | AuthCredentialTypes.OPEN_ID_CONNECT = AuthCredentialTypes.OAUTH2,
): AuthCredential {
  return {
    authType,
    oauth2: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      expiresAt: 1,
    },
  };
}

/** Answers the token endpoint with a freshly minted access token. */
function stubTokenEndpoint(accessToken: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: accessToken,
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }),
    })),
  );
}

/** A credential service that records its calls and answers from memory. */
class RecordingCredentialService implements BaseCredentialService {
  readonly saved: AuthCredential[] = [];
  loadCalls = 0;

  constructor(private stored?: AuthCredential) {}

  async loadCredential(): Promise<AuthCredential | undefined> {
    this.loadCalls++;
    return this.stored;
  }

  async saveCredential(authConfig: AuthConfig): Promise<void> {
    if (authConfig.exchangedAuthCredential) {
      this.stored = authConfig.exchangedAuthCredential;
      this.saved.push(authConfig.exchangedAuthCredential);
    }
  }
}

function createToolContext(credentialService?: BaseCredentialService): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'session-id',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    credentialService,
  });

  return new Context({invocationContext, functionCallId: 'call-1'});
}

function createAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    authScheme: OAUTH2_SCHEME,
    rawAuthCredential: OAUTH2_CREDENTIAL,
    credentialKey: 'test-key',
    ...overrides,
  };
}

describe('CredentialManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('requestCredential', () => {
    it('forwards the auth config to the tool context', async () => {
      const authConfig = createAuthConfig();
      const toolContext = createToolContext();
      const requestCredential = vi.spyOn(toolContext, 'requestCredential');

      await new CredentialManager(authConfig).requestCredential(toolContext);

      expect(requestCredential).toHaveBeenCalledWith(authConfig);
    });
  });

  describe('ready credentials', () => {
    it('returns an API key credential without consulting the service', async () => {
      const credentialService = new RecordingCredentialService();
      const manager = new CredentialManager(
        createAuthConfig({
          authScheme: API_KEY_SCHEME,
          rawAuthCredential: API_KEY_CREDENTIAL,
        }),
      );

      expect(
        await manager.getAuthCredential(createToolContext(credentialService)),
      ).toEqual(API_KEY_CREDENTIAL);
      expect(credentialService.loadCalls).toBe(0);
    });

    it('returns an HTTP credential without consulting the service', async () => {
      const httpCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'static-token'}},
      };
      const credentialService = new RecordingCredentialService();
      const manager = new CredentialManager(
        createAuthConfig({
          authScheme: {type: 'http', scheme: 'bearer'},
          rawAuthCredential: httpCredential,
        }),
      );

      expect(
        await manager.getAuthCredential(createToolContext(credentialService)),
      ).toEqual(httpCredential);
      expect(credentialService.loadCalls).toBe(0);
    });

    it('does not short-circuit an OAuth2 raw credential', async () => {
      const credentialService = new RecordingCredentialService();
      const manager = new CredentialManager(createAuthConfig());

      await manager.getAuthCredential(createToolContext(credentialService));

      expect(credentialService.loadCalls).toBe(1);
    });
  });

  describe('validation', () => {
    it('rejects an oauth2 scheme with no raw credential', async () => {
      const manager = new CredentialManager(
        createAuthConfig({rawAuthCredential: undefined}),
      );

      await expect(
        manager.getAuthCredential(createToolContext()),
      ).rejects.toThrow(
        'rawAuthCredential is required for auth scheme type oauth2',
      );
    });

    it('rejects an openIdConnect scheme with no raw credential', async () => {
      const manager = new CredentialManager(
        createAuthConfig({
          authScheme: OPEN_ID_CONNECT_SCHEME,
          rawAuthCredential: undefined,
        }),
      );

      await expect(
        manager.getAuthCredential(createToolContext()),
      ).rejects.toThrow(
        'rawAuthCredential is required for auth scheme type openIdConnect',
      );
    });

    it('accepts an apiKey scheme with no raw credential', async () => {
      const manager = new CredentialManager(
        createAuthConfig({
          authScheme: API_KEY_SCHEME,
          rawAuthCredential: undefined,
        }),
      );

      expect(
        await manager.getAuthCredential(createToolContext()),
      ).toBeUndefined();
    });

    it('rejects an OAuth2 credential that carries no oauth2 field', async () => {
      const manager = new CredentialManager(
        createAuthConfig({
          rawAuthCredential: {authType: AuthCredentialTypes.OAUTH2},
        }),
      );

      await expect(
        manager.getAuthCredential(createToolContext()),
      ).rejects.toThrow(
        'authConfig.rawAuthCredential.oauth2 is required for credential type oauth2',
      );
    });

    it('rejects an OpenID Connect credential that carries no oauth2 field', async () => {
      const manager = new CredentialManager(
        createAuthConfig({
          authScheme: OPEN_ID_CONNECT_SCHEME,
          rawAuthCredential: {authType: AuthCredentialTypes.OPEN_ID_CONNECT},
        }),
      );

      await expect(
        manager.getAuthCredential(createToolContext()),
      ).rejects.toThrow(
        'authConfig.rawAuthCredential.oauth2 is required for credential type openIdConnect',
      );
    });
  });

  describe('loading', () => {
    it('loads the credential the service holds', async () => {
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'stored-token'},
      };
      const credentialService = new RecordingCredentialService(stored);
      const manager = new CredentialManager(createAuthConfig());

      expect(
        await manager.getAuthCredential(createToolContext(credentialService)),
      ).toEqual(stored);
      expect(credentialService.saved).toEqual([]);
    });

    it('falls back to the cached exchanged credential', async () => {
      const cached: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'cached-token'},
      };
      const credentialService = new RecordingCredentialService();
      const manager = new CredentialManager(
        createAuthConfig({exchangedAuthCredential: cached}),
      );

      expect(
        await manager.getAuthCredential(createToolContext(credentialService)),
      ).toEqual(cached);
    });

    it('returns undefined when nothing holds a credential', async () => {
      const manager = new CredentialManager(createAuthConfig());

      expect(
        await manager.getAuthCredential(
          createToolContext(new RecordingCredentialService()),
        ),
      ).toBeUndefined();
    });

    it('picks the credential up from the auth response and saves it', async () => {
      const fromAuthResponse: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'response-token'},
      };
      const credentialService = new RecordingCredentialService();
      const toolContext = createToolContext(credentialService);
      vi.spyOn(toolContext, 'getAuthResponse').mockReturnValue(
        fromAuthResponse,
      );
      const authConfig = createAuthConfig();

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(toolContext);

      expect(credential).toEqual(fromAuthResponse);
      expect(credentialService.saved).toEqual([fromAuthResponse]);
      // The caller's config is shared by every user of the tool, so the
      // manager must not write the credential into it.
      expect(authConfig.exchangedAuthCredential).toBeUndefined();
    });

    it('does not leak one user credential to the next user', async () => {
      const authConfig = createAuthConfig();
      const manager = new CredentialManager(authConfig);
      const firstUser = createToolContext(new RecordingCredentialService());
      vi.spyOn(firstUser, 'getAuthResponse').mockReturnValue({
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'first-user-token'},
      });

      await manager.getAuthCredential(firstUser);
      const secondUser = createToolContext(new RecordingCredentialService());

      expect(await manager.getAuthCredential(secondUser)).toBeUndefined();
    });

    it('neither loads nor saves when no credential service is configured', async () => {
      const fromAuthResponse: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'response-token'},
      };
      const toolContext = createToolContext();
      vi.spyOn(toolContext, 'getAuthResponse').mockReturnValue(
        fromAuthResponse,
      );
      const authConfig = createAuthConfig();

      const credential = await new CredentialManager(
        authConfig,
      ).getAuthCredential(toolContext);

      expect(credential).toEqual(fromAuthResponse);
      expect(authConfig.exchangedAuthCredential).toBeUndefined();
    });
  });

  describe('exchange', () => {
    it('exchanges a service account credential through its exchanger', async () => {
      const exchanged: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
      };
      const exchanger: BaseCredentialExchanger = {
        exchange: vi.fn(
          async (): Promise<ExchangeResult> => ({
            credential: exchanged,
            wasExchanged: true,
          }),
        ),
      };
      const serviceAccountCredential: AuthCredential = {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      };
      const credentialService = new RecordingCredentialService(
        serviceAccountCredential,
      );
      const authConfig = createAuthConfig({
        rawAuthCredential: serviceAccountCredential,
      });
      const manager = new CredentialManager(authConfig);
      manager.registerCredentialExchanger(
        AuthCredentialTypes.SERVICE_ACCOUNT,
        exchanger,
      );

      const credential = await manager.getAuthCredential(
        createToolContext(credentialService),
      );

      expect(credential).toEqual(exchanged);
      expect(exchanger.exchange).toHaveBeenCalledWith({
        authScheme: authConfig.authScheme,
        authCredential: serviceAccountCredential,
      });
      expect(credentialService.saved).toEqual([exchanged]);
    });

    it('returns the credential unchanged when no exchanger is registered', async () => {
      const stored: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'stored-api-key',
      };
      const credentialService = new RecordingCredentialService(stored);
      const manager = new CredentialManager(
        createAuthConfig({
          authScheme: API_KEY_SCHEME,
          rawAuthCredential: undefined,
        }),
      );

      expect(
        await manager.getAuthCredential(createToolContext(credentialService)),
      ).toEqual(stored);
      expect(credentialService.saved).toEqual([]);
    });

    it('overrides the built-in exchanger for a credential type', async () => {
      const overridden: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'override-token'}},
      };
      const serviceAccountCredential: AuthCredential = {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      };
      const manager = new CredentialManager(
        createAuthConfig({rawAuthCredential: serviceAccountCredential}),
      );
      manager.registerCredentialExchanger(AuthCredentialTypes.SERVICE_ACCOUNT, {
        exchange: async () => ({credential: overridden, wasExchanged: true}),
      });

      const credential = await manager.getAuthCredential(
        createToolContext(
          new RecordingCredentialService(serviceAccountCredential),
        ),
      );

      expect(credential).toEqual(overridden);
    });

    it('still refreshes when the exchanger reports it did not exchange', async () => {
      stubTokenEndpoint('refreshed-after-declined-exchange');
      const credentialService = new RecordingCredentialService(
        createExpiredCredential(),
      );
      const manager = new CredentialManager(createAuthConfig());
      manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, {
        exchange: async ({authCredential}) => ({
          credential: authCredential,
          wasExchanged: false,
        }),
      });

      const credential = await manager.getAuthCredential(
        createToolContext(credentialService),
      );

      expect(credential?.oauth2?.accessToken).toBe(
        'refreshed-after-declined-exchange',
      );
      expect(credentialService.saved).toHaveLength(1);
    });

    it('skips the refresh when the exchanger reports it exchanged', async () => {
      const exchanged = createExpiredCredential();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const manager = new CredentialManager(createAuthConfig());
      manager.registerCredentialExchanger(AuthCredentialTypes.OAUTH2, {
        exchange: async () => ({credential: exchanged, wasExchanged: true}),
      });

      const credential = await manager.getAuthCredential(
        createToolContext(
          new RecordingCredentialService(createExpiredCredential()),
        ),
      );

      expect(credential).toEqual(exchanged);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('refreshes an expired OAuth2 credential and saves it', async () => {
      stubTokenEndpoint('refreshed-token');
      const credentialService = new RecordingCredentialService(
        createExpiredCredential(),
      );
      const manager = new CredentialManager(createAuthConfig());

      const credential = await manager.getAuthCredential(
        createToolContext(credentialService),
      );

      expect(credential?.oauth2?.accessToken).toBe('refreshed-token');
      expect(credentialService.saved).toHaveLength(1);
    });

    it('leaves a credential that does not need refreshing untouched', async () => {
      const live: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'live-token'},
      };
      const credentialService = new RecordingCredentialService(live);
      const manager = new CredentialManager(createAuthConfig());

      expect(
        await manager.getAuthCredential(createToolContext(credentialService)),
      ).toEqual(live);
      expect(credentialService.saved).toEqual([]);
    });

    it('refreshes an OpenID Connect credential with the shared refresher', async () => {
      stubTokenEndpoint('oidc-refreshed-token');
      const credentialService = new RecordingCredentialService(
        createExpiredCredential(AuthCredentialTypes.OPEN_ID_CONNECT),
      );
      const manager = new CredentialManager(
        createAuthConfig({
          authScheme: OPEN_ID_CONNECT_SCHEME,
          rawAuthCredential: {
            authType: AuthCredentialTypes.OPEN_ID_CONNECT,
            oauth2: {clientId: 'client-id'},
          },
        }),
      );

      const credential = await manager.getAuthCredential(
        createToolContext(credentialService),
      );

      expect(credential?.oauth2?.accessToken).toBe('oidc-refreshed-token');
    });
  });
});
