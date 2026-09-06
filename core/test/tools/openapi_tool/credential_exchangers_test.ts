/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWT} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccountCredential,
} from '../../../src/auth/auth_credential.js';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';
import {ServiceAccountCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';

const AUDIENCE = 'https://my-service.run.app';

/**
 * Shared ID-token fakes. They are hoisted so the `google-auth-library` factory
 * can install them, and so a test can re-arm one without rebuilding the module
 * mock.
 */
const idTokenMocks = vi.hoisted(() => {
  const jwtFetchIdToken = vi.fn<(targetAudience: string) => Promise<string>>();
  const adcFetchIdToken = vi.fn<(targetAudience: string) => Promise<string>>();
  const getIdTokenClient =
    vi.fn<
      (
        targetAudience: string,
      ) => Promise<{idTokenProvider: {fetchIdToken: typeof adcFetchIdToken}}>
    >();
  return {jwtFetchIdToken, adcFetchIdToken, getIdTokenClient};
});

vi.mock('google-auth-library', () => {
  return {
    JWT: vi.fn().mockImplementation(() => ({
      authorize: vi.fn().mockResolvedValue({access_token: 'mock-token'}),
      fetchIdToken: idTokenMocks.jwtFetchIdToken,
    })),
    GoogleAuth: vi.fn().mockImplementation(() => ({
      getClient: vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue({token: 'mock-adc-token'}),
      }),
      getIdTokenClient: idTokenMocks.getIdTokenClient,
    })),
  };
});

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

describe('ServiceAccountCredentialExchanger ID token', () => {
  const explicitKey: ServiceAccountCredential = {
    type: 'service_account',
    projectId: 'test-project',
    privateKeyId: 'private-key-id',
    privateKey: 'key',
    clientEmail: 'test@example.com',
    clientId: 'client-id',
    authUri: 'https://accounts.google.com/o/oauth2/auth',
    tokenUri: 'https://oauth2.googleapis.com/token',
    authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
    clientX509CertUrl: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
    universeDomain: 'googleapis.com',
  };

  beforeEach(() => {
    vi.mocked(JWT).mockClear();
    vi.mocked(GoogleAuth).mockClear();
    idTokenMocks.jwtFetchIdToken.mockReset().mockResolvedValue('mock-id-token');
    idTokenMocks.adcFetchIdToken
      .mockReset()
      .mockResolvedValue('mock-adc-id-token');
    idTokenMocks.getIdTokenClient.mockReset().mockResolvedValue({
      idTokenProvider: {fetchIdToken: idTokenMocks.adcFetchIdToken},
    });
  });

  it('should mint an ID token with explicit keys', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: explicitKey,
        useIdToken: true,
        audience: AUDIENCE,
      },
    };

    const result = await exchanger.exchange({authCredential: credential});

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(result.credential.http?.scheme).toBe('bearer');
    expect(result.credential.http?.credentials.token).toBe('mock-id-token');
    expect(result.credential.http?.additionalHeaders).toBeUndefined();
    expect(vi.mocked(JWT)).toHaveBeenCalledWith({
      email: explicitKey.clientEmail,
      key: explicitKey.privateKey,
    });
    expect(idTokenMocks.jwtFetchIdToken).toHaveBeenCalledWith(AUDIENCE);
  });

  it('should mint an ID token with default credentials', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
        useIdToken: true,
        audience: AUDIENCE,
      },
    };

    const result = await exchanger.exchange({authCredential: credential});

    expect(result.credential.http?.credentials.token).toBe('mock-adc-id-token');
    expect(result.credential.http?.additionalHeaders).toBeUndefined();
    expect(vi.mocked(GoogleAuth)).toHaveBeenCalledWith();
    expect(idTokenMocks.getIdTokenClient).toHaveBeenCalledWith(AUDIENCE);
    expect(idTokenMocks.adcFetchIdToken).toHaveBeenCalledWith(AUDIENCE);
  });

  it('should throw if audience is missing', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true, useIdToken: true},
    };

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(/audience is required when useIdToken is true/);
    expect(idTokenMocks.getIdTokenClient).not.toHaveBeenCalled();
  });

  it('should throw if explicit credentials are missing on the ID token path', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useIdToken: true, audience: AUDIENCE},
    };

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(/^Service account credentials are missing\.$/);
  });

  it('should prefer default credentials over explicit keys', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
        serviceAccountCredential: explicitKey,
        useIdToken: true,
        audience: AUDIENCE,
      },
    };

    const result = await exchanger.exchange({authCredential: credential});

    expect(result.credential.http?.credentials.token).toBe('mock-adc-id-token');
    expect(vi.mocked(JWT)).not.toHaveBeenCalled();
  });

  it('should wrap an explicit key ID token failure', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: explicitKey,
        useIdToken: true,
        audience: AUDIENCE,
      },
    };
    idTokenMocks.jwtFetchIdToken.mockRejectedValueOnce(
      new Error('Auth failed'),
    );

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(
      'Failed to exchange service account for ID token: Auth failed',
    );
  });

  it('should wrap a default credential ID token failure', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
        useIdToken: true,
        audience: AUDIENCE,
      },
    };
    idTokenMocks.getIdTokenClient.mockRejectedValueOnce(
      new Error('ADC unavailable'),
    );

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(
      'Failed to exchange service account for ID token: ADC unavailable',
    );
  });

  it('should still mint an access token when useIdToken is false', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: explicitKey,
        useIdToken: false,
        audience: AUDIENCE,
      },
    };

    const result = await exchanger.exchange({authCredential: credential});

    expect(result.credential.http?.credentials.token).toBe('mock-token');
    expect(idTokenMocks.jwtFetchIdToken).not.toHaveBeenCalled();
  });
});
