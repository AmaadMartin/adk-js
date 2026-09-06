/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {JWT} from 'google-auth-library';
import {describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {AuthScheme} from '../../../src/auth/auth_schemes.js';
import {BaseCredentialExchanger} from '../../../src/auth/exchanger/base_credential_exchanger.js';
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

const AUTH_SCHEME: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
};

/** The credential a stub exchanger resolves to, used as a fingerprint. */
const STUB_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'stub-token'}},
};

function createStubExchanger(): BaseCredentialExchanger {
  return {
    exchange: vi
      .fn()
      .mockResolvedValue({credential: STUB_CREDENTIAL, wasExchanged: true}),
  };
}

describe('AutoAuthCredentialExchanger', () => {
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

  it('should merge custom exchangers over the built-ins', () => {
    const stub = createStubExchanger();

    const exchanger = new AutoAuthCredentialExchanger(
      new Map([[AuthCredentialTypes.API_KEY, stub]]),
    );

    expect(exchanger.exchangers.get(AuthCredentialTypes.API_KEY)).toBe(stub);
    expect(exchanger.exchangers.has(AuthCredentialTypes.SERVICE_ACCOUNT)).toBe(
      true,
    );
    expect(exchanger.exchangers.get(AuthCredentialTypes.OAUTH2)).toBe(
      exchanger.exchangers.get(AuthCredentialTypes.OPEN_ID_CONNECT),
    );
  });

  it('should keep the OAuth2 built-in for openIdConnect when a custom exchanger is added', async () => {
    const exchanger = new AutoAuthCredentialExchanger(
      new Map([[AuthCredentialTypes.API_KEY, createStubExchanger()]]),
    );

    await expect(
      exchanger.exchange({
        authCredential: {authType: AuthCredentialTypes.OPEN_ID_CONNECT},
      }),
    ).rejects.toThrow('authScheme is required for OAuth2 credential exchange');
  });

  it('should route through an exchanger set on the public exchangers map', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const stub = createStubExchanger();
    exchanger.exchangers.set(AuthCredentialTypes.OPEN_ID_CONNECT, stub);
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
    };

    const result = await exchanger.exchange({
      authScheme: AUTH_SCHEME,
      authCredential,
    });

    expect(result).toEqual({credential: STUB_CREDENTIAL, wasExchanged: true});
    const calls = vi.mocked(stub.exchange).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].authScheme).toBe(AUTH_SCHEME);
    expect(calls[0][0].authCredential).toBe(authCredential);
  });

  it('should let a custom exchanger replace a built-in', async () => {
    const stub = createStubExchanger();
    const exchanger = new AutoAuthCredentialExchanger(
      new Map([[AuthCredentialTypes.SERVICE_ACCOUNT, stub]]),
    );

    const result = await exchanger.exchange({
      authScheme: AUTH_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      },
    });

    expect(result.credential).toBe(STUB_CREDENTIAL);
    expect(vi.mocked(stub.exchange)).toHaveBeenCalledTimes(1);
  });

  it('should add a custom exchanger for a type with no built-in', async () => {
    const stub = createStubExchanger();
    const exchanger = new AutoAuthCredentialExchanger(
      new Map([[AuthCredentialTypes.API_KEY, stub]]),
    );

    const result = await exchanger.exchange({
      authScheme: AUTH_SCHEME,
      authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'key'},
    });

    expect(result.credential).toBe(STUB_CREDENTIAL);
    expect(vi.mocked(stub.exchange)).toHaveBeenCalledTimes(1);
  });

  it('should ignore a change made to the custom exchangers map after construction', async () => {
    const stub = createStubExchanger();
    const customExchangers = new Map([[AuthCredentialTypes.API_KEY, stub]]);
    const exchanger = new AutoAuthCredentialExchanger(customExchangers);
    const replacement = createStubExchanger();

    customExchangers.set(AuthCredentialTypes.API_KEY, replacement);
    await exchanger.exchange({
      authScheme: AUTH_SCHEME,
      authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'key'},
    });

    expect(vi.mocked(stub.exchange)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replacement.exchange)).not.toHaveBeenCalled();
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
