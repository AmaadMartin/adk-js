/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {IdTokenClient} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
  ServiceAccountCredential,
} from '../../../../../src/auth/auth_credential.js';
import {
  resetCredentialCaches,
  ServiceAccountCredentialExchanger,
} from '../../../../../src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const QUOTA_PROJECT_HEADER = 'x-goog-user-project';
const AUDIENCE = 'https://my-service.run.app';

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
      credentials: {expiry_date?: number | null};
      getAccessToken: typeof getAccessToken;
    }>
  >();
  const authorize =
    vi.fn<
      () => Promise<{access_token?: string; expiry_date?: number | null}>
    >();
  const fetchIdToken = vi.fn<(audience: string) => Promise<string>>();
  const adcFetchIdToken = vi.fn<(audience: string) => Promise<string>>();
  const getIdTokenClient =
    vi.fn<(audience: string) => Promise<IdTokenClient>>();
  const googleAuthOptions = vi.fn<(options?: {scopes?: string[]}) => void>();
  const jwtOptions =
    vi.fn<(options: {email: string; key: string; scopes?: string[]}) => void>();
  return {
    getAccessToken,
    getProjectId,
    getClient,
    authorize,
    fetchIdToken,
    adcFetchIdToken,
    getIdTokenClient,
    googleAuthOptions,
    jwtOptions,
  };
});

// `IdTokenClient` is kept real: it owns the ID-token caching this suite
// checks, and it drives the faked `fetchIdToken` exactly as the library does.
vi.mock('google-auth-library', async (importOriginal) => ({
  IdTokenClient: (await importOriginal<typeof import('google-auth-library')>())
    .IdTokenClient,
  GoogleAuth: class {
    getClient = authMocks.getClient;
    getProjectId = authMocks.getProjectId;
    getIdTokenClient = authMocks.getIdTokenClient;

    constructor(options?: {scopes?: string[]}) {
      authMocks.googleAuthOptions(options);
    }
  },
  JWT: class {
    authorize = authMocks.authorize;
    fetchIdToken = authMocks.fetchIdToken;

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
    resetCredentialCaches();
    vi.clearAllMocks();
    authMocks.getAccessToken.mockResolvedValue({token: 'adc-access-token'});
    authMocks.getClient.mockResolvedValue({
      credentials: {},
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
      credentials: {},
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

/** Builds an unsigned JWT whose payload carries the given claims. */
function idToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${payload}.signature`;
}

/** An ID token that stays valid well past the client's eager-refresh window. */
function freshIdToken(): string {
  return idToken({exp: Math.floor(Date.now() / 1000) + 3600});
}

/** Matches MAX_CACHED_CLIENTS in the exchanger. */
const CACHE_CAP = 100;

describe('ServiceAccountCredentialExchanger client cache', () => {
  const exchanger = new ServiceAccountCredentialExchanger();
  const explicitAccessToken = serviceAccountCredential({
    serviceAccountCredential: SA_CREDENTIAL,
    scopes: [BIGQUERY_SCOPE],
  });
  const explicitIdToken = serviceAccountCredential({
    serviceAccountCredential: SA_CREDENTIAL,
    useIdToken: true,
    audience: AUDIENCE,
  });

  beforeEach(() => {
    resetCredentialCaches();
    vi.clearAllMocks();
    authMocks.getAccessToken.mockResolvedValue({token: 'adc-access-token'});
    authMocks.getClient.mockResolvedValue({
      credentials: {},
      getAccessToken: authMocks.getAccessToken,
    });
    authMocks.getProjectId.mockRejectedValue(
      new Error('Unable to detect a Project Id'),
    );
    authMocks.authorize.mockResolvedValue({access_token: 'sa-access-token'});
    authMocks.fetchIdToken.mockImplementation(async () => freshIdToken());
    authMocks.adcFetchIdToken.mockImplementation(async () => freshIdToken());
    authMocks.getIdTokenClient.mockImplementation(
      async (audience: string) =>
        new IdTokenClient({
          targetAudience: audience,
          idTokenProvider: {fetchIdToken: authMocks.adcFetchIdToken},
        }),
    );
  });

  it('reuses the JWT client for the same configuration', async () => {
    await exchanger.exchange({authCredential: explicitAccessToken});
    await exchanger.exchange({authCredential: explicitAccessToken});

    expect(authMocks.jwtOptions).toHaveBeenCalledOnce();
  });

  it('reuses the ADC client for the same configuration', async () => {
    const adcCredential = serviceAccountCredential({
      useDefaultCredential: true,
    });

    await exchanger.exchange({authCredential: adcCredential});
    await exchanger.exchange({authCredential: adcCredential});

    expect(authMocks.googleAuthOptions).toHaveBeenCalledOnce();
  });

  it('keeps the quota project header on a reused ADC client', async () => {
    authMocks.getClient.mockResolvedValue({
      quotaProjectId: 'client-quota-project',
      credentials: {},
      getAccessToken: authMocks.getAccessToken,
    });
    const adcCredential = serviceAccountCredential({
      useDefaultCredential: true,
    });

    await exchanger.exchange({authCredential: adcCredential});
    const second = await exchanger.exchange({authCredential: adcCredential});

    expect(second.credential.http?.additionalHeaders).toEqual({
      [QUOTA_PROJECT_HEADER]: 'client-quota-project',
    });
  });

  it('builds a separate client per scope list', async () => {
    await exchanger.exchange({authCredential: explicitAccessToken});
    await exchanger.exchange({
      authCredential: serviceAccountCredential({
        serviceAccountCredential: SA_CREDENTIAL,
        scopes: [CLOUD_PLATFORM_SCOPE],
      }),
    });

    expect(authMocks.jwtOptions).toHaveBeenCalledTimes(2);
  });

  it('builds a separate client per client email', async () => {
    await exchanger.exchange({authCredential: explicitAccessToken});
    await exchanger.exchange({
      authCredential: serviceAccountCredential({
        serviceAccountCredential: {
          ...SA_CREDENTIAL,
          clientEmail: 'other@sa-project.iam.gserviceaccount.com',
        },
        scopes: [BIGQUERY_SCOPE],
      }),
    });

    expect(authMocks.jwtOptions).toHaveBeenCalledTimes(2);
  });

  it('does not serve an ADC exchange from an explicit client', async () => {
    await exchanger.exchange({authCredential: explicitIdToken});
    const adcResult = await exchanger.exchange({
      authCredential: serviceAccountCredential({
        useDefaultCredential: true,
        serviceAccountCredential: SA_CREDENTIAL,
        useIdToken: true,
        audience: AUDIENCE,
      }),
    });

    expect(authMocks.adcFetchIdToken).toHaveBeenCalledWith(AUDIENCE);
    expect(adcResult.credential.http?.credentials.token).toBe(
      await authMocks.adcFetchIdToken.mock.results[0].value,
    );
  });

  it('does not re-fetch an ID token that is still valid', async () => {
    await exchanger.exchange({authCredential: explicitIdToken});
    await exchanger.exchange({authCredential: explicitIdToken});

    expect(authMocks.jwtOptions).toHaveBeenCalledOnce();
    expect(authMocks.fetchIdToken).toHaveBeenCalledOnce();
  });

  it('re-fetches an ID token that carries no readable expiry', async () => {
    authMocks.fetchIdToken.mockResolvedValue('an-opaque-token');

    await exchanger.exchange({authCredential: explicitIdToken});
    await exchanger.exchange({authCredential: explicitIdToken});

    expect(authMocks.jwtOptions).toHaveBeenCalledOnce();
    expect(authMocks.fetchIdToken).toHaveBeenCalledTimes(2);
  });

  it('re-fetches an ID token that has expired', async () => {
    authMocks.fetchIdToken.mockResolvedValue(
      idToken({exp: Math.floor(Date.now() / 1000) - 60}),
    );

    await exchanger.exchange({authCredential: explicitIdToken});
    await exchanger.exchange({authCredential: explicitIdToken});

    expect(authMocks.fetchIdToken).toHaveBeenCalledTimes(2);
  });

  it('builds a separate ID token client per audience', async () => {
    await exchanger.exchange({authCredential: explicitIdToken});
    await exchanger.exchange({
      authCredential: serviceAccountCredential({
        serviceAccountCredential: SA_CREDENTIAL,
        useIdToken: true,
        audience: 'https://another.run.app',
      }),
    });

    expect(authMocks.fetchIdToken).toHaveBeenCalledTimes(2);
    expect(authMocks.fetchIdToken).toHaveBeenLastCalledWith(
      'https://another.run.app',
    );
  });

  it('reuses the ADC ID token client', async () => {
    const adcIdToken = serviceAccountCredential({
      useDefaultCredential: true,
      useIdToken: true,
      audience: AUDIENCE,
    });

    await exchanger.exchange({authCredential: adcIdToken});
    await exchanger.exchange({authCredential: adcIdToken});

    expect(authMocks.getIdTokenClient).toHaveBeenCalledOnce();
    expect(authMocks.adcFetchIdToken).toHaveBeenCalledOnce();
  });

  it('wraps an ID token client that yields an empty token', async () => {
    authMocks.fetchIdToken.mockResolvedValue('');

    await expect(
      exchanger.exchange({authCredential: explicitIdToken}),
    ).rejects.toThrow(
      'Failed to exchange service account for ID token: Failed to get ID token',
    );
  });

  it('builds a new client after resetCredentialCaches', async () => {
    await exchanger.exchange({authCredential: explicitAccessToken});
    resetCredentialCaches();
    await exchanger.exchange({authCredential: explicitAccessToken});

    expect(authMocks.jwtOptions).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest client once the cache is full', async () => {
    const forScope = (index: number) =>
      serviceAccountCredential({
        serviceAccountCredential: SA_CREDENTIAL,
        scopes: [`https://www.googleapis.com/auth/scope-${index}`],
      });

    for (let index = 0; index < CACHE_CAP; index++) {
      await exchanger.exchange({authCredential: forScope(index)});
    }
    expect(authMocks.jwtOptions).toHaveBeenCalledTimes(CACHE_CAP);

    await exchanger.exchange({authCredential: forScope(CACHE_CAP)});
    await exchanger.exchange({authCredential: forScope(CACHE_CAP)});
    expect(authMocks.jwtOptions).toHaveBeenCalledTimes(CACHE_CAP + 1);

    await exchanger.exchange({authCredential: forScope(0)});
    expect(authMocks.jwtOptions).toHaveBeenCalledTimes(CACHE_CAP + 2);

    // Rebuilding scope-0 evicted scope-1, the new oldest entry.
    await exchanger.exchange({authCredential: forScope(2)});
    expect(authMocks.jwtOptions).toHaveBeenCalledTimes(CACHE_CAP + 2);
  });
});
