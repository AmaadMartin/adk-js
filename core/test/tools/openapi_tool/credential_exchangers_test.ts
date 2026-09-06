/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, ToolAuthHandler} from '@google/adk';
import {JWT} from 'google-auth-library';
import {afterEach, describe, expect, it, MockInstance, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {AuthScheme} from '../../../src/auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../src/auth/exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from '../../../src/auth/exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialExchanger} from '../../../src/auth/oauth2/oauth2_credential_exchanger.js';
import {State} from '../../../src/sessions/state.js';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';
import {ServiceAccountCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';

vi.mock('google-auth-library', () => {
  return {
    JWT: vi.fn().mockImplementation(() => ({
      authorize: vi.fn().mockResolvedValue({access_token: 'mock-token'}),
    })),
    GoogleAuth: vi.fn().mockImplementation(() => ({
      getClient: vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue({token: 'mock-adc-token'}),
      }),
    })),
  };
});

const authScheme: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
};

/**
 * Spies created by the tests below. They are restored one by one, because
 * `vi.restoreAllMocks()` would also strip the `google-auth-library` factory
 * mock that the other suite in this file depends on.
 */
const activeSpies: Array<MockInstance<BaseCredentialExchanger['exchange']>> =
  [];

/** Spies on an exchanger prototype and registers the spy for restoration. */
function spyOnExchange(exchangerClass: {
  prototype: BaseCredentialExchanger;
}): MockInstance<BaseCredentialExchanger['exchange']> {
  const spy = vi.spyOn(exchangerClass.prototype, 'exchange');
  activeSpies.push(spy);

  return spy;
}

/** Builds an override registry holding a single exchanger. */
function registryWith(
  credentialType: AuthCredentialTypes,
  exchanger: BaseCredentialExchanger,
): CredentialExchangerRegistry {
  const registry = new CredentialExchangerRegistry();
  registry.register(credentialType, exchanger);

  return registry;
}

/** An exchanger that reports the call it received and marks it exchanged. */
function createRecordingExchanger() {
  return {
    exchange: vi.fn(
      async (params: {
        authScheme?: AuthScheme;
        authCredential: AuthCredential;
      }): Promise<ExchangeResult> => ({
        credential: params.authCredential,
        wasExchanged: true,
      }),
    ),
  } satisfies BaseCredentialExchanger;
}

describe('AutoAuthCredentialExchanger', () => {
  afterEach(() => {
    for (const spy of activeSpies.splice(0)) {
      spy.mockRestore();
    }
  });

  it('should return original credential if no exchanger registered', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const credential = {authType: AuthCredentialTypes.API_KEY, apiKey: 'key'};

    const result = await exchanger.exchange({authCredential: credential});

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toEqual(credential);
  });

  it('should use ServiceAccountCredentialExchanger for serviceAccount', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
      },
    };

    const result = await exchanger.exchange({
      authCredential: credential as unknown as AuthCredential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-adc-token');
  });

  it('throws CredentialExchangeError when no credential is supplied', async () => {
    const exchanger = new AutoAuthCredentialExchanger();

    const exchangeWithoutCredential = () =>
      exchanger.exchange({
        authScheme,
        authCredential: undefined as unknown as AuthCredential,
      });

    await expect(exchangeWithoutCredential()).rejects.toThrow(
      CredentialExchangeError,
    );
    await expect(exchangeWithoutCredential()).rejects.toThrow(
      'authCredential is required for credential exchange.',
    );
  });

  it('uses a custom exchanger for a type with no default', async () => {
    const recording = createRecordingExchanger();
    const exchanger = new AutoAuthCredentialExchanger(
      registryWith(AuthCredentialTypes.API_KEY, recording),
    );
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key',
    };

    const result = await exchanger.exchange({authScheme, authCredential});

    expect(result).toEqual({credential: authCredential, wasExchanged: true});
    expect(recording.exchange).toHaveBeenCalledTimes(1);
    expect(recording.exchange).toHaveBeenCalledWith({
      authScheme,
      authCredential,
    });
  });

  it('keeps the built-in exchangers when custom ones are added', async () => {
    const sentinel: ExchangeResult = {
      credential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'exchanged'},
      wasExchanged: true,
    };
    const spy = spyOnExchange(OAuth2CredentialExchanger).mockResolvedValue(
      sentinel,
    );
    const exchanger = new AutoAuthCredentialExchanger(
      registryWith(AuthCredentialTypes.API_KEY, createRecordingExchanger()),
    );
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
    };

    const result = await exchanger.exchange({authScheme, authCredential});

    expect(result).toBe(sentinel);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lets a custom exchanger override a built-in', async () => {
    const recording = createRecordingExchanger();
    const builtIn = spyOnExchange(ServiceAccountCredentialExchanger);
    const exchanger = new AutoAuthCredentialExchanger(
      registryWith(AuthCredentialTypes.SERVICE_ACCOUNT, recording),
    );
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    const result = await exchanger.exchange({authScheme, authCredential});

    expect(result).toEqual({credential: authCredential, wasExchanged: true});
    expect(recording.exchange).toHaveBeenCalledTimes(1);
    expect(builtIn).not.toHaveBeenCalled();
  });

  it('delegates openIdConnect to the OAuth2 exchanger with scheme and credential', async () => {
    const sentinel: ExchangeResult = {
      credential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'oidc'},
      wasExchanged: true,
    };
    const spy = spyOnExchange(OAuth2CredentialExchanger).mockResolvedValue(
      sentinel,
    );
    const exchanger = new AutoAuthCredentialExchanger();
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
    };

    const result = await exchanger.exchange({authScheme, authCredential});

    expect(result).toBe(sentinel);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({authScheme, authCredential});
  });

  it('delegates oauth2 to the OAuth2 exchanger', async () => {
    const sentinel: ExchangeResult = {
      credential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'oauth2'},
      wasExchanged: true,
    };
    const spy = spyOnExchange(OAuth2CredentialExchanger).mockResolvedValue(
      sentinel,
    );
    const exchanger = new AutoAuthCredentialExchanger();
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
    };

    const result = await exchanger.exchange({authScheme, authCredential});

    expect(result).toBe(sentinel);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({authScheme, authCredential});
  });
});

describe('ServiceAccountCredentialExchanger', () => {
  it('should throw if not service account credential', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {authType: AuthCredentialTypes.API_KEY};

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow(
      'Invalid credential type for ServiceAccountCredentialExchanger',
    );
  });

  it('should exchange with explicit keys', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: {
          clientEmail: 'test@example.com',
          privateKey: 'key',
        },
      },
    };

    const result = await exchanger.exchange({
      authCredential: credential as unknown as AuthCredential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-token');
  });

  it('should exchange with default credentials', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
      },
    };

    const result = await exchanger.exchange({
      authCredential: credential as unknown as AuthCredential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-adc-token');
  });

  it('should throw if explicit credentials missing', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: false,
      },
    };

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow('Service account credentials are missing.');
  });

  it('should throw if token exchange fails (missing token)', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: {
          clientEmail: 'test@example.com',
          privateKey: 'key',
        },
      },
    };

    const mockJWT = vi.mocked(JWT);
    mockJWT.mockImplementationOnce(
      () =>
        ({
          authorize: vi.fn().mockResolvedValue({}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow(
      'Failed to exchange explicit service account token: Failed to get access token from explicit credentials',
    );
  });

  it('should throw if token exchange throws error', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: {
          clientEmail: 'test@example.com',
          privateKey: 'key',
        },
      },
    };

    const mockJWT = vi.mocked(JWT);
    mockJWT.mockImplementationOnce(
      () =>
        ({
          authorize: vi.fn().mockRejectedValue(new Error('Auth failed')),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow(
      'Failed to exchange explicit service account token: Auth failed',
    );
  });
});

describe('ToolAuthHandler with an injected exchanger', () => {
  it('routes an apiKey credential through a custom exchanger', async () => {
    const recording = createRecordingExchanger();
    const context = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = ToolAuthHandler.fromToolContext(
      context,
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      undefined,
      {
        credentialExchanger: new AutoAuthCredentialExchanger(
          registryWith(AuthCredentialTypes.API_KEY, recording),
        ),
      },
    );

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(recording.exchange).toHaveBeenCalledTimes(1);
  });
});
