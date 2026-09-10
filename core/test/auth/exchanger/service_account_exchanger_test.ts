/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccountCredential,
} from '../../../src/auth/auth_credential.js';
import {ServiceAccountCredentialExchanger} from '../../../src/auth/exchanger/service_account_exchanger.js';

// Hoisted so the two failure tests can drive `JWT.authorize` directly, rather
// than replacing the mocked constructor with a partial cast to `any`.
const {jwtAuthorize} = vi.hoisted(() => ({jwtAuthorize: vi.fn()}));

vi.mock('google-auth-library', () => {
  return {
    JWT: vi.fn().mockImplementation(() => ({
      authorize: jwtAuthorize,
    })),
    GoogleAuth: vi.fn().mockImplementation(() => ({
      getClient: vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue({token: 'mock-adc-token'}),
      }),
    })),
  };
});

jwtAuthorize.mockResolvedValue({access_token: 'mock-token'});

/** A complete, entirely fictional service account key. */
const SERVICE_ACCOUNT_CREDENTIAL: ServiceAccountCredential = {
  type: 'service_account',
  projectId: 'test-project',
  privateKeyId: 'test-private-key-id',
  privateKey: 'key',
  clientEmail: 'test@example.com',
  clientId: 'test-client-id',
  authUri: 'https://accounts.google.com/o/oauth2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
  authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
  clientX509CertUrl: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
  universeDomain: 'googleapis.com',
};

describe('ServiceAccountCredentialExchanger', () => {
  it('should throw if not service account credential', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
    };

    await expect(
      exchanger.exchange({
        authCredential: credential,
      }),
    ).rejects.toThrow(
      'Invalid credential type for ServiceAccountCredentialExchanger',
    );
  });

  it('should exchange with explicit keys', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      },
    };

    const result = await exchanger.exchange({
      authCredential: credential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-token');
  });

  it('should exchange with default credentials', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
      },
    };

    const result = await exchanger.exchange({
      authCredential: credential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-adc-token');
  });

  it('should throw if explicit credentials missing', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: false,
      },
    };

    await expect(
      exchanger.exchange({
        authCredential: credential,
      }),
    ).rejects.toThrow('Service account credentials are missing.');
  });

  it('should throw if token exchange fails (missing token)', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      },
    };

    jwtAuthorize.mockResolvedValueOnce({});

    await expect(
      exchanger.exchange({
        authCredential: credential,
      }),
    ).rejects.toThrow(
      'Failed to exchange explicit service account token: Failed to get access token from explicit credentials',
    );
  });

  it('should throw if token exchange throws error', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
      },
    };

    jwtAuthorize.mockRejectedValueOnce(new Error('Auth failed'));

    await expect(
      exchanger.exchange({
        authCredential: credential,
      }),
    ).rejects.toThrow(
      'Failed to exchange explicit service account token: Auth failed',
    );
  });
});
