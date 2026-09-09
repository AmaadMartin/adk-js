/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccountCredential,
} from '../../../src/auth/auth_credential.js';
import {ServiceAccountCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';

const mocks = vi.hoisted(() => ({
  client: {
    getAccessToken: vi.fn(),
    quotaProjectId: undefined as string | undefined,
  },
  getProjectId: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  JWT: vi.fn().mockImplementation(() => ({authorize: mocks.authorize})),
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue(mocks.client),
    getProjectId: mocks.getProjectId,
  })),
}));

const EXPLICIT_CREDENTIAL: ServiceAccountCredential = {
  type: 'service_account',
  projectId: 'explicit_project',
  privateKeyId: 'key_id',
  privateKey: 'private_key',
  clientEmail: 'test@example.com',
  clientId: 'client_id',
  authUri: 'https://accounts.google.com/o/oauth2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
  authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
  clientX509CertUrl: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
  universeDomain: 'googleapis.com',
};

function defaultCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: {useDefaultCredential: true},
  };
}

describe('ServiceAccountCredentialExchanger quota project', () => {
  const exchanger = new ServiceAccountCredentialExchanger();

  beforeEach(() => {
    mocks.client.quotaProjectId = undefined;
    mocks.client.getAccessToken.mockReset().mockResolvedValue({
      token: 'mock-adc-token',
    });
    mocks.getProjectId.mockReset();
    mocks.authorize.mockReset().mockResolvedValue({access_token: 'mock-token'});
  });

  it('should prefer the client quota project over the ADC project', async () => {
    mocks.client.quotaProjectId = 'test_project';
    mocks.getProjectId.mockResolvedValue('another_project');

    const result = await exchanger.exchange({
      authCredential: defaultCredential(),
    });

    expect(result.credential.http?.additionalHeaders).toEqual({
      'x-goog-user-project': 'test_project',
    });
    expect(mocks.getProjectId).not.toHaveBeenCalled();
  });

  it('should fall back to the ADC project id', async () => {
    mocks.getProjectId.mockResolvedValue('adc_project');

    const result = await exchanger.exchange({
      authCredential: defaultCredential(),
    });

    expect(result.credential.http?.additionalHeaders).toEqual({
      'x-goog-user-project': 'adc_project',
    });
  });

  it('should fall back to the ADC project id for an empty quota project', async () => {
    mocks.client.quotaProjectId = '';
    mocks.getProjectId.mockResolvedValue('adc_project');

    const result = await exchanger.exchange({
      authCredential: defaultCredential(),
    });

    expect(result.credential.http?.additionalHeaders).toEqual({
      'x-goog-user-project': 'adc_project',
    });
  });

  it('should omit the header when no project id can be detected', async () => {
    mocks.getProjectId.mockRejectedValue(
      new Error('Unable to detect a Project Id in the current environment.'),
    );

    const result = await exchanger.exchange({
      authCredential: defaultCredential(),
    });

    expect(result.credential.http?.additionalHeaders).toBeUndefined();
    expect(result.credential.http?.credentials.token).toBe('mock-adc-token');
    expect(result.wasExchanged).toBe(true);
  });

  it('should omit the header on the explicit key path', async () => {
    const result = await exchanger.exchange({
      authCredential: {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {serviceAccountCredential: EXPLICIT_CREDENTIAL},
      },
    });

    expect(result.credential.http?.additionalHeaders).toBeUndefined();
    expect(result.credential.http?.credentials.token).toBe('mock-token');
  });
});
