/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, AuthCredentialTypes} from '@google/adk';
import {GoogleAuth, JWT} from 'google-auth-library';
import {describe, expect, it, vi} from 'vitest';
import {ServiceAccountCredentialExchanger} from '../../../src/auth/exchanger/service_account_credential_exchanger.js';

// Mock google-auth-library
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
        }) as unknown as JWT,
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
        }) as unknown as JWT,
    );

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow(
      'Failed to exchange explicit service account token: Auth failed',
    );
  });

  it('should throw if the default credentials yield no token', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    vi.mocked(GoogleAuth).mockImplementationOnce(
      () =>
        ({
          getClient: vi.fn().mockResolvedValue({
            getAccessToken: vi.fn().mockResolvedValue({}),
          }),
        }) as unknown as GoogleAuth,
    );

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(
      'Failed to exchange default service account token: Failed to get access token from default credentials',
    );
  });

  it('should throw if resolving the default credentials fails', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    vi.mocked(GoogleAuth).mockImplementationOnce(
      () =>
        ({
          getClient: vi.fn().mockRejectedValue(new Error('ADC failed')),
        }) as unknown as GoogleAuth,
    );

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(
      'Failed to exchange default service account token: ADC failed',
    );
  });

  it('should pass the configured scopes to GoogleAuth, defaulting to cloud-platform', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const withScopes: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
        scopes: ['https://www.googleapis.com/auth/drive'],
      },
    };

    await exchanger.exchange({authCredential: withScopes});

    expect(vi.mocked(GoogleAuth)).toHaveBeenLastCalledWith({
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const withoutScopes: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    await exchanger.exchange({authCredential: withoutScopes});

    expect(vi.mocked(GoogleAuth)).toHaveBeenLastCalledWith({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  });
});
