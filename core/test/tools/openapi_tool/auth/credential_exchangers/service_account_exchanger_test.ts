/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
  ServiceAccountCredential,
} from '../../../../../src/auth/auth_credential.js';
import {ServiceAccountCredentialExchanger} from '../../../../../src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const QUOTA_PROJECT_HEADER = 'x-goog-user-project';

/**
 * Fakes for `google-auth-library`. They are hoisted so the module factory can
 * install them, and so each test can arm one without rebuilding the mock.
 */
const authMocks = vi.hoisted(() => {
  const getAccessToken = vi.fn<() => Promise<{token: string | null}>>();
  const getProjectId = vi.fn<() => Promise<string>>();
  const getClient = vi.fn<
    () => Promise<{
      quotaProjectId?: string;
      getAccessToken: typeof getAccessToken;
    }>
  >();
  const authorize = vi.fn<() => Promise<{access_token?: string}>>();
  const googleAuthOptions = vi.fn<(options?: {scopes?: string[]}) => void>();
  const jwtOptions =
    vi.fn<(options: {email: string; key: string; scopes?: string[]}) => void>();
  return {
    getAccessToken,
    getProjectId,
    getClient,
    authorize,
    googleAuthOptions,
    jwtOptions,
  };
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient = authMocks.getClient;
    getProjectId = authMocks.getProjectId;

    constructor(options?: {scopes?: string[]}) {
      authMocks.googleAuthOptions(options);
    }
  },
  JWT: class {
    authorize = authMocks.authorize;

    constructor(options: {email: string; key: string; scopes?: string[]}) {
      authMocks.jwtOptions(options);
    }
  },
}));

const SA_CREDENTIAL: ServiceAccountCredential = {
  type: 'service_account',
  projectId: 'sa-project',
  privateKeyId: 'private-key-id',
  privateKey: 'private-key',
  clientEmail: 'agent@sa-project.iam.gserviceaccount.com',
  clientId: 'client-id',
  authUri: 'https://accounts.google.com/o/oauth2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
  authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
  clientX509CertUrl: 'https://www.googleapis.com/robot/v1/metadata/x509/agent',
  universeDomain: 'googleapis.com',
};

function serviceAccountCredential(
  serviceAccount: ServiceAccount,
): AuthCredential {
  return {authType: AuthCredentialTypes.SERVICE_ACCOUNT, serviceAccount};
}

describe('ServiceAccountCredentialExchanger access token', () => {
  const exchanger = new ServiceAccountCredentialExchanger();

  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getAccessToken.mockResolvedValue({token: 'adc-access-token'});
    authMocks.getClient.mockResolvedValue({
      getAccessToken: authMocks.getAccessToken,
    });
    authMocks.getProjectId.mockRejectedValue(
      new Error('Unable to detect a Project Id'),
    );
    authMocks.authorize.mockResolvedValue({access_token: 'sa-access-token'});
  });

  it('mints an access token from explicit credentials', async () => {
    const result = await exchanger.exchange({
      authCredential: serviceAccountCredential({
        serviceAccountCredential: SA_CREDENTIAL,
        scopes: [BIGQUERY_SCOPE],
      }),
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(result.credential.http?.scheme).toBe('bearer');
    expect(result.credential.http?.credentials.token).toBe('sa-access-token');
    expect(result.credential.http?.additionalHeaders).toBeUndefined();
    expect(authMocks.jwtOptions).toHaveBeenCalledWith({
      email: SA_CREDENTIAL.clientEmail,
      key: SA_CREDENTIAL.privateKey,
      scopes: [BIGQUERY_SCOPE],
    });
  });

  it("uses the auth client's quota project for the header", async () => {
    authMocks.getClient.mockResolvedValue({
      quotaProjectId: 'client-quota-project',
      getAccessToken: authMocks.getAccessToken,
    });
    authMocks.getProjectId.mockResolvedValue('adc-project');

    const result = await exchanger.exchange({
      authCredential: serviceAccountCredential({useDefaultCredential: true}),
    });

    expect(result.credential.http?.additionalHeaders).toEqual({
      [QUOTA_PROJECT_HEADER]: 'client-quota-project',
    });
    expect(authMocks.getProjectId).not.toHaveBeenCalled();
  });

  it('falls back to the ADC project for the header', async () => {
    authMocks.getProjectId.mockResolvedValue('adc-project');

    const result = await exchanger.exchange({
      authCredential: serviceAccountCredential({useDefaultCredential: true}),
    });

    expect(result.credential.http?.additionalHeaders).toEqual({
      [QUOTA_PROJECT_HEADER]: 'adc-project',
    });
  });

  it('omits the header when no project resolves', async () => {
    const result = await exchanger.exchange({
      authCredential: serviceAccountCredential({useDefaultCredential: true}),
    });

    expect(result.credential.http?.credentials.token).toBe('adc-access-token');
    expect(result.credential.http?.additionalHeaders).toBeUndefined();
    expect(authMocks.getProjectId).toHaveBeenCalledOnce();
  });

  it('defaults the ADC scope to cloud-platform', async () => {
    await exchanger.exchange({
      authCredential: serviceAccountCredential({useDefaultCredential: true}),
    });

    expect(authMocks.googleAuthOptions).toHaveBeenCalledWith({
      scopes: [CLOUD_PLATFORM_SCOPE],
    });
  });

  it('keeps the configured ADC scopes', async () => {
    await exchanger.exchange({
      authCredential: serviceAccountCredential({
        useDefaultCredential: true,
        scopes: [BIGQUERY_SCOPE],
      }),
    });

    expect(authMocks.googleAuthOptions).toHaveBeenCalledWith({
      scopes: [BIGQUERY_SCOPE],
    });
  });

  it('rejects a credential that is not a service account', async () => {
    await expect(
      exchanger.exchange({
        authCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'an-api-key',
        },
      }),
    ).rejects.toThrow(
      'Invalid credential type for ServiceAccountCredentialExchanger',
    );
  });

  it('rejects a service account credential with no configuration', async () => {
    await expect(
      exchanger.exchange({
        authCredential: {authType: AuthCredentialTypes.SERVICE_ACCOUNT},
      }),
    ).rejects.toThrow(
      'Service account credentials are missing. Please provide them, or set ' +
        '`useDefaultCredential = true` to use application default credential ' +
        'in a hosted service like Cloud Run.',
    );
  });

  it('rejects explicit exchange with no key material', async () => {
    await expect(
      exchanger.exchange({
        authCredential: serviceAccountCredential({
          useDefaultCredential: false,
          scopes: [BIGQUERY_SCOPE],
        }),
      }),
    ).rejects.toThrow(
      'Service account credentials are missing. serviceAccountCredential is ' +
        'required when useDefaultCredential is false.',
    );
    expect(authMocks.jwtOptions).not.toHaveBeenCalled();
  });

  it('rejects explicit exchange with no scopes', async () => {
    await expect(
      exchanger.exchange({
        authCredential: serviceAccountCredential({
          serviceAccountCredential: SA_CREDENTIAL,
        }),
      }),
    ).rejects.toThrow(
      'scopes are required when using explicit service account credentials ' +
        'for access token exchange.',
    );
    expect(authMocks.jwtOptions).not.toHaveBeenCalled();
  });

  it('rejects explicit exchange with an empty scope list', async () => {
    await expect(
      exchanger.exchange({
        authCredential: serviceAccountCredential({
          serviceAccountCredential: SA_CREDENTIAL,
          scopes: [],
        }),
      }),
    ).rejects.toThrow(
      'scopes are required when using explicit service account credentials ' +
        'for access token exchange.',
    );
  });

  it('wraps an explicit exchange failure', async () => {
    authMocks.authorize.mockRejectedValue(new Error('invalid_grant'));

    await expect(
      exchanger.exchange({
        authCredential: serviceAccountCredential({
          serviceAccountCredential: SA_CREDENTIAL,
          scopes: [BIGQUERY_SCOPE],
        }),
      }),
    ).rejects.toThrow(
      'Failed to exchange service account token: invalid_grant',
    );
  });

  it('wraps an explicit exchange that yields no token', async () => {
    authMocks.authorize.mockResolvedValue({});

    await expect(
      exchanger.exchange({
        authCredential: serviceAccountCredential({
          serviceAccountCredential: SA_CREDENTIAL,
          scopes: [BIGQUERY_SCOPE],
        }),
      }),
    ).rejects.toThrow(
      'Failed to exchange service account token: Failed to get access token ' +
        'from explicit credentials',
    );
  });

  it('wraps an ADC exchange failure', async () => {
    authMocks.getClient.mockRejectedValue(new Error('ADC not found'));

    await expect(
      exchanger.exchange({
        authCredential: serviceAccountCredential({useDefaultCredential: true}),
      }),
    ).rejects.toThrow(
      'Failed to exchange service account token: ADC not found',
    );
  });

  it('wraps an ADC exchange that yields no token', async () => {
    authMocks.getAccessToken.mockResolvedValue({token: null});

    await expect(
      exchanger.exchange({
        authCredential: serviceAccountCredential({useDefaultCredential: true}),
      }),
    ).rejects.toThrow(
      'Failed to exchange service account token: Failed to get access token ' +
        'from default credentials',
    );
  });
});
