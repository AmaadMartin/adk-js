/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, AuthCredentialTypes} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';

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
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    const result = await exchanger.exchange({authCredential: credential});

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-adc-token');
  });
});
