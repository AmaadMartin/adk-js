/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialMissingError,
  AuthCredentialTypes,
  Context,
  createSession,
  InputValidationError,
  InvocationContext,
  OpenAPIToolset,
  PluginManager,
  ServiceAccount,
  ServiceAccountCredential,
} from '@google/adk';
import type {
  Credentials,
  GoogleAuthOptions,
  JWTOptions,
} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ServiceAccountCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';
import {resetServiceAccountTokenCache} from '../../../src/tools/openapi_tool/auth/credential_exchangers/token_cache.js';

interface FakeJwt {
  authorize: () => Promise<Credentials>;
  fetchIdToken: (audience: string) => Promise<string>;
}

interface FakeAuthClient {
  getAccessToken: () => Promise<{token: string | null}>;
  credentials?: Credentials;
  quotaProjectId?: string;
}

interface FakeIdTokenClient {
  idTokenProvider: {fetchIdToken: (audience: string) => Promise<string>};
}

interface FakeGoogleAuth {
  getClient: () => Promise<FakeAuthClient>;
  getProjectId: () => Promise<string>;
  getIdTokenClient: (audience: string) => Promise<FakeIdTokenClient>;
}

const {jwtConstructor, googleAuthConstructor} = vi.hoisted(() => ({
  jwtConstructor: vi.fn<(options: JWTOptions) => FakeJwt>(),
  googleAuthConstructor:
    vi.fn<(options?: GoogleAuthOptions) => FakeGoogleAuth>(),
}));

vi.mock('google-auth-library', () => ({
  JWT: jwtConstructor,
  GoogleAuth: googleAuthConstructor,
}));

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const AUDIENCE = 'https://my-service.run.app';
const ONE_HOUR_SECONDS = 3600;
const SKEW_SECONDS = 300;
const START_MS = Date.UTC(2026, 7, 10, 12, 0, 0);

const SA_CREDENTIAL: ServiceAccountCredential = {
  type: 'service_account',
  projectId: 'test-project',
  privateKeyId: 'test-private-key-id',
  privateKey: '-----BEGIN PRIVATE KEY-----test',
  clientEmail: 'test@test.iam.gserviceaccount.com',
  clientId: 'test-client-id',
  authUri: 'https://accounts.google.com/o/oauth2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
  authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
  clientX509CertUrl: 'https://www.googleapis.com/robot/v1/metadata/x509/test',
  universeDomain: 'googleapis.com',
};

function credentialFor(serviceAccount: ServiceAccount): AuthCredential {
  return {authType: AuthCredentialTypes.SERVICE_ACCOUNT, serviceAccount};
}

function fakeJwt(overrides: Partial<FakeJwt> = {}): FakeJwt {
  return {
    authorize: () => Promise.resolve({access_token: 'explicit-token'}),
    fetchIdToken: () => Promise.resolve('explicit-id-token'),
    ...overrides,
  };
}

function fakeGoogleAuth(
  overrides: Partial<FakeGoogleAuth> = {},
): FakeGoogleAuth {
  return {
    getClient: () =>
      Promise.resolve({
        getAccessToken: () => Promise.resolve({token: 'adc-token'}),
      }),
    getProjectId: () => Promise.reject(new Error('no ambient project')),
    getIdTokenClient: () =>
      Promise.resolve({
        idTokenProvider: {fetchIdToken: () => Promise.resolve('adc-id-token')},
      }),
    ...overrides,
  };
}

function base64url(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Builds a token shaped like a JWT whose payload carries `exp`. */
function jwtWithExpiry(expirySeconds: number): string {
  return `header.${base64url(JSON.stringify({exp: expirySeconds}))}.signature`;
}

describe('ServiceAccountCredentialExchanger', () => {
  let exchanger: ServiceAccountCredentialExchanger;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    resetServiceAccountTokenCache();
    jwtConstructor.mockReset();
    googleAuthConstructor.mockReset();
    jwtConstructor.mockImplementation(() => fakeJwt());
    googleAuthConstructor.mockImplementation(() => fakeGoogleAuth());
    exchanger = new ServiceAccountCredentialExchanger();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('access token exchange', () => {
    it('exchanges an explicit service account key for a bearer access token', async () => {
      const result = await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential: SA_CREDENTIAL,
          scopes: [CLOUD_PLATFORM_SCOPE],
        }),
      });

      expect(result.wasExchanged).toBe(true);
      expect(result.credential.authType).toBe(AuthCredentialTypes.HTTP);
      expect(result.credential.http?.scheme).toBe('bearer');
      expect(result.credential.http?.credentials.token).toBe('explicit-token');
      expect(result.credential.http?.additionalHeaders).toBeUndefined();
      expect(jwtConstructor).toHaveBeenCalledWith({
        email: SA_CREDENTIAL.clientEmail,
        key: SA_CREDENTIAL.privateKey,
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
    });

    it('sends the quota project of the default credentials', async () => {
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({
          getClient: () =>
            Promise.resolve({
              getAccessToken: () => Promise.resolve({token: 'adc-token'}),
              quotaProjectId: 'credential-project',
            }),
          getProjectId: () => Promise.resolve('adc-project'),
        }),
      );

      const result = await exchanger.exchange({
        authCredential: credentialFor({
          useDefaultCredential: true,
          scopes: [BIGQUERY_SCOPE],
        }),
      });

      expect(result.credential.http?.credentials.token).toBe('adc-token');
      expect(result.credential.http?.additionalHeaders).toEqual({
        'x-goog-user-project': 'credential-project',
      });
      expect(googleAuthConstructor).toHaveBeenCalledWith({
        scopes: [BIGQUERY_SCOPE],
      });
    });

    it('falls back to the project of the default credentials for the quota header', async () => {
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({getProjectId: () => Promise.resolve('adc-project')}),
      );

      const result = await exchanger.exchange({
        authCredential: credentialFor({
          useDefaultCredential: true,
          scopes: [BIGQUERY_SCOPE],
        }),
      });

      expect(result.credential.http?.additionalHeaders).toEqual({
        'x-goog-user-project': 'adc-project',
      });
    });

    it('falls back to the ADC project when the quota project is empty', async () => {
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({
          getClient: () =>
            Promise.resolve({
              getAccessToken: () => Promise.resolve({token: 'adc-token'}),
              quotaProjectId: '',
            }),
          getProjectId: () => Promise.resolve('adc-project'),
        }),
      );

      const result = await exchanger.exchange({
        authCredential: credentialFor({
          useDefaultCredential: true,
          scopes: [BIGQUERY_SCOPE],
        }),
      });

      expect(result.credential.http?.additionalHeaders).toEqual({
        'x-goog-user-project': 'adc-project',
      });
    });

    it('returns a token without a quota header when no project can be resolved', async () => {
      const result = await exchanger.exchange({
        authCredential: credentialFor({
          useDefaultCredential: true,
          scopes: [BIGQUERY_SCOPE],
        }),
      });

      expect(result.credential.http?.credentials.token).toBe('adc-token');
      expect(result.credential.http?.additionalHeaders).toBeUndefined();
    });

    it('asks for the cloud platform scope when the configuration has none', async () => {
      await exchanger.exchange({
        authCredential: credentialFor({useDefaultCredential: true}),
      });

      expect(googleAuthConstructor).toHaveBeenCalledWith({
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
    });

    it('reports an empty default credentials response as a missing credential', async () => {
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({
          getClient: () =>
            Promise.resolve({
              getAccessToken: () => Promise.resolve({token: null}),
            }),
        }),
      );
      const exchange = () =>
        exchanger.exchange({
          authCredential: credentialFor({useDefaultCredential: true}),
        });

      await expect(exchange()).rejects.toThrow(AuthCredentialMissingError);
      await expect(exchange()).rejects.toThrow(
        'Failed to exchange service account token: Failed to get access token from default credentials',
      );
    });

    it('reports a failed access token exchange as a missing credential', async () => {
      jwtConstructor.mockImplementation(() =>
        fakeJwt({authorize: () => Promise.reject(new Error('Auth failed'))}),
      );
      const exchange = () =>
        exchanger.exchange({
          authCredential: credentialFor({
            serviceAccountCredential: SA_CREDENTIAL,
            scopes: [CLOUD_PLATFORM_SCOPE],
          }),
        });

      await expect(exchange()).rejects.toThrow(AuthCredentialMissingError);
      await expect(exchange()).rejects.toThrow(
        'Failed to exchange service account token: Auth failed',
      );
    });
  });

  describe('configuration validation', () => {
    it('rejects a credential that carries no service account', async () => {
      const exchange = () =>
        exchanger.exchange({
          authCredential: {authType: AuthCredentialTypes.SERVICE_ACCOUNT},
        });

      await expect(exchange()).rejects.toThrow(AuthCredentialMissingError);
      await expect(exchange()).rejects.toThrow(
        'Service account credentials are missing. Please provide them',
      );
    });

    it('rejects explicit credentials that carry no scopes', async () => {
      const exchange = () =>
        exchanger.exchange({
          authCredential: credentialFor({
            serviceAccountCredential: SA_CREDENTIAL,
          }),
        });

      await expect(exchange()).rejects.toThrow(AuthCredentialMissingError);
      await expect(exchange()).rejects.toThrow('scopes are required');
      expect(jwtConstructor).not.toHaveBeenCalled();
    });

    it('rejects an ID token request that names no audience', async () => {
      const exchange = () =>
        exchanger.exchange({
          authCredential: credentialFor({
            useDefaultCredential: true,
            useIdToken: true,
          }),
        });

      await expect(exchange()).rejects.toThrow(InputValidationError);
      await expect(exchange()).rejects.toThrow('audience is required');
    });

    it('rejects an ID token request that has neither a key nor default credentials', async () => {
      const exchange = () =>
        exchanger.exchange({
          authCredential: credentialFor({
            useDefaultCredential: false,
            useIdToken: true,
            audience: AUDIENCE,
          }),
        });

      await expect(exchange()).rejects.toThrow(AuthCredentialMissingError);
      await expect(exchange()).rejects.toThrow(
        'serviceAccountCredential is required when useDefaultCredential is false.',
      );
    });
  });

  describe('ID token exchange', () => {
    it('mints an ID token from an explicit service account key', async () => {
      const fetchIdToken = vi.fn(() => Promise.resolve('explicit-id-token'));
      jwtConstructor.mockImplementation(() => fakeJwt({fetchIdToken}));

      const result = await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential: SA_CREDENTIAL,
          scopes: [CLOUD_PLATFORM_SCOPE],
          useIdToken: true,
          audience: AUDIENCE,
        }),
      });

      expect(result.credential.http?.scheme).toBe('bearer');
      expect(result.credential.http?.credentials.token).toBe(
        'explicit-id-token',
      );
      expect(result.credential.http?.additionalHeaders).toBeUndefined();
      expect(fetchIdToken).toHaveBeenCalledWith(AUDIENCE);
      expect(jwtConstructor).toHaveBeenCalledWith({
        email: SA_CREDENTIAL.clientEmail,
        key: SA_CREDENTIAL.privateKey,
      });
    });

    it('mints an ID token from the default credentials', async () => {
      const getIdTokenClient = vi.fn(() =>
        Promise.resolve({
          idTokenProvider: {
            fetchIdToken: () => Promise.resolve('adc-id-token'),
          },
        }),
      );
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({getIdTokenClient}),
      );

      const result = await exchanger.exchange({
        authCredential: credentialFor({
          useDefaultCredential: true,
          useIdToken: true,
          audience: AUDIENCE,
        }),
      });

      expect(result.credential.http?.credentials.token).toBe('adc-id-token');
      expect(result.credential.http?.additionalHeaders).toBeUndefined();
      expect(getIdTokenClient).toHaveBeenCalledWith(AUDIENCE);
    });

    it('reports a failed explicit ID token exchange as a missing credential', async () => {
      jwtConstructor.mockImplementation(() =>
        fakeJwt({
          fetchIdToken: () => Promise.reject(new Error('key rejected')),
        }),
      );
      const exchange = () =>
        exchanger.exchange({
          authCredential: credentialFor({
            serviceAccountCredential: SA_CREDENTIAL,
            useIdToken: true,
            audience: AUDIENCE,
          }),
        });

      await expect(exchange()).rejects.toThrow(AuthCredentialMissingError);
      await expect(exchange()).rejects.toThrow(
        'Failed to exchange service account for ID token: key rejected',
      );
    });

    it('reports a failed default credentials ID token exchange as a missing credential', async () => {
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({
          getIdTokenClient: () =>
            Promise.reject(new Error('Metadata service unavailable')),
        }),
      );
      const exchange = () =>
        exchanger.exchange({
          authCredential: credentialFor({
            useDefaultCredential: true,
            useIdToken: true,
            audience: AUDIENCE,
          }),
        });

      await expect(exchange()).rejects.toThrow(AuthCredentialMissingError);
      await expect(exchange()).rejects.toThrow(
        'Failed to exchange service account for ID token: Metadata service unavailable',
      );
    });
  });

  describe('token cache', () => {
    it('reuses an access token until it approaches its expiry', async () => {
      const expiryMs = START_MS + 30 * 60 * 1000;
      jwtConstructor.mockImplementation(() =>
        fakeJwt({
          authorize: () =>
            Promise.resolve({
              access_token: 'first-token',
              expiry_date: expiryMs,
            }),
        }),
      );
      const authCredential = credentialFor({
        serviceAccountCredential: SA_CREDENTIAL,
        scopes: [CLOUD_PLATFORM_SCOPE],
      });

      const first = await exchanger.exchange({authCredential});
      const second = await exchanger.exchange({authCredential});

      expect(first.credential.http?.credentials.token).toBe('first-token');
      expect(second.credential.http?.credentials.token).toBe('first-token');
      expect(jwtConstructor).toHaveBeenCalledTimes(1);

      vi.setSystemTime(expiryMs - (SKEW_SECONDS - 100) * 1000);
      jwtConstructor.mockImplementation(() =>
        fakeJwt({
          authorize: () => Promise.resolve({access_token: 'second-token'}),
        }),
      );

      const third = await exchanger.exchange({authCredential});

      expect(third.credential.http?.credentials.token).toBe('second-token');
      expect(jwtConstructor).toHaveBeenCalledTimes(2);
    });

    it('does not reuse an access token minted for other scopes', async () => {
      const serviceAccountCredential = SA_CREDENTIAL;
      await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential,
          scopes: [CLOUD_PLATFORM_SCOPE],
        }),
      });
      await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential,
          scopes: [BIGQUERY_SCOPE],
        }),
      });

      expect(jwtConstructor).toHaveBeenCalledTimes(2);
    });

    it('does not reuse an access token minted for another client email', async () => {
      await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential: {
            ...SA_CREDENTIAL,
            clientEmail: 'sa1@example.com',
          },
          scopes: [CLOUD_PLATFORM_SCOPE],
        }),
      });
      await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential: {
            ...SA_CREDENTIAL,
            clientEmail: 'sa2@example.com',
          },
          scopes: [CLOUD_PLATFORM_SCOPE],
        }),
      });

      expect(jwtConstructor).toHaveBeenCalledTimes(2);
    });

    it('reuses a default credentials access token until its expiry date', async () => {
      const expiryMs = START_MS + 30 * 60 * 1000;
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({
          getClient: () =>
            Promise.resolve({
              getAccessToken: () => Promise.resolve({token: 'adc-token'}),
              credentials: {expiry_date: expiryMs},
            }),
        }),
      );
      const authCredential = credentialFor({
        useDefaultCredential: true,
        scopes: [BIGQUERY_SCOPE],
      });

      await exchanger.exchange({authCredential});
      await exchanger.exchange({authCredential});

      expect(googleAuthConstructor).toHaveBeenCalledTimes(1);

      vi.setSystemTime(expiryMs - (SKEW_SECONDS - 100) * 1000);
      await exchanger.exchange({authCredential});

      expect(googleAuthConstructor).toHaveBeenCalledTimes(2);
    });

    it('reuses an explicit ID token until its exp claim approaches', async () => {
      const expirySeconds = START_MS / 1000 + 30 * 60;
      jwtConstructor.mockImplementation(() =>
        fakeJwt({
          fetchIdToken: () => Promise.resolve(jwtWithExpiry(expirySeconds)),
        }),
      );
      const authCredential = credentialFor({
        serviceAccountCredential: SA_CREDENTIAL,
        useIdToken: true,
        audience: AUDIENCE,
      });

      await exchanger.exchange({authCredential});
      await exchanger.exchange({authCredential});

      expect(jwtConstructor).toHaveBeenCalledTimes(1);

      vi.setSystemTime((expirySeconds - SKEW_SECONDS + 100) * 1000);
      await exchanger.exchange({authCredential});

      expect(jwtConstructor).toHaveBeenCalledTimes(2);
    });

    it('reuses a default credentials ID token until its exp claim approaches', async () => {
      const expirySeconds = START_MS / 1000 + 30 * 60;
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({
          getIdTokenClient: () =>
            Promise.resolve({
              idTokenProvider: {
                fetchIdToken: () =>
                  Promise.resolve(jwtWithExpiry(expirySeconds)),
              },
            }),
        }),
      );
      const authCredential = credentialFor({
        useDefaultCredential: true,
        useIdToken: true,
        audience: AUDIENCE,
      });

      const first = await exchanger.exchange({authCredential});
      await exchanger.exchange({authCredential});

      expect(first.credential.http?.credentials.token).toBe(
        jwtWithExpiry(expirySeconds),
      );
      expect(googleAuthConstructor).toHaveBeenCalledTimes(1);

      vi.setSystemTime((expirySeconds - SKEW_SECONDS + 100) * 1000);
      await exchanger.exchange({authCredential});

      expect(googleAuthConstructor).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['is not three segments', 'opaque-id-token'],
      ['is not JSON', `header.${base64url('not json')}.signature`],
      ['is not an object', `header.${base64url('123')}.signature`],
      ['is null', `header.${base64url('null')}.signature`],
      ['has no exp claim', `header.${base64url('{}')}.signature`],
      [
        'has a non-numeric exp claim',
        `header.${base64url('{"exp":"soon"}')}.signature`,
      ],
    ])(
      'caches an ID token for one hour when its payload %s',
      async (_description, token) => {
        googleAuthConstructor.mockImplementation(() =>
          fakeGoogleAuth({
            getIdTokenClient: () =>
              Promise.resolve({
                idTokenProvider: {fetchIdToken: () => Promise.resolve(token)},
              }),
          }),
        );
        const authCredential = credentialFor({
          useDefaultCredential: true,
          useIdToken: true,
          audience: AUDIENCE,
        });

        const first = await exchanger.exchange({authCredential});
        expect(first.credential.http?.credentials.token).toBe(token);

        vi.setSystemTime(
          START_MS + (ONE_HOUR_SECONDS - SKEW_SECONDS - 60) * 1000,
        );
        await exchanger.exchange({authCredential});
        expect(googleAuthConstructor).toHaveBeenCalledTimes(1);

        vi.setSystemTime(
          START_MS + (ONE_HOUR_SECONDS - SKEW_SECONDS + 60) * 1000,
        );
        await exchanger.exchange({authCredential});
        expect(googleAuthConstructor).toHaveBeenCalledTimes(2);
      },
    );

    it('evicts the oldest entry once the cache is full', async () => {
      const cacheCapacity = 100;
      const oldest = credentialFor({
        serviceAccountCredential: SA_CREDENTIAL,
        scopes: ['scope-0'],
      });

      for (let index = 0; index < cacheCapacity; index++) {
        await exchanger.exchange({
          authCredential: credentialFor({
            serviceAccountCredential: SA_CREDENTIAL,
            scopes: [`scope-${index}`],
          }),
        });
      }
      expect(jwtConstructor).toHaveBeenCalledTimes(cacheCapacity);

      await exchanger.exchange({authCredential: oldest});
      expect(jwtConstructor).toHaveBeenCalledTimes(cacheCapacity);

      await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential: SA_CREDENTIAL,
          scopes: ['scope-overflow'],
        }),
      });
      await exchanger.exchange({authCredential: oldest});

      expect(jwtConstructor).toHaveBeenCalledTimes(cacheCapacity + 2);
    });

    it('does not reuse an access token for an ID token request', async () => {
      const serviceAccountCredential = SA_CREDENTIAL;
      await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential,
          scopes: [CLOUD_PLATFORM_SCOPE],
        }),
      });
      const idToken = await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential,
          scopes: [CLOUD_PLATFORM_SCOPE],
          useIdToken: true,
          audience: AUDIENCE,
        }),
      });

      expect(idToken.credential.http?.credentials.token).toBe(
        'explicit-id-token',
      );
      expect(jwtConstructor).toHaveBeenCalledTimes(2);
    });

    it('does not reuse an ID token minted for another audience', async () => {
      const serviceAccountCredential = SA_CREDENTIAL;
      await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential,
          useIdToken: true,
          audience: AUDIENCE,
        }),
      });
      await exchanger.exchange({
        authCredential: credentialFor({
          serviceAccountCredential,
          useIdToken: true,
          audience: 'https://other-service.run.app',
        }),
      });

      expect(jwtConstructor).toHaveBeenCalledTimes(2);
    });
  });

  describe('as configured on an OpenAPI tool', () => {
    /** The spec from the developer guide's "Get started" section. */
    const GUIDE_SPEC = JSON.stringify({
      openapi: '3.0.0',
      info: {title: 'Datasets', version: '1.0.0'},
      servers: [{url: 'https://bigquery.googleapis.com/bigquery/v2'}],
      components: {
        securitySchemes: {
          google: {
            type: 'oauth2',
            flows: {
              authorizationCode: {
                authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
                tokenUrl: 'https://oauth2.googleapis.com/token',
                scopes: {[BIGQUERY_SCOPE]: 'Manage BigQuery data.'},
              },
            },
          },
        },
      },
      security: [{google: [BIGQUERY_SCOPE]}],
      paths: {
        '/projects/{projectId}/datasets': {
          get: {
            operationId: 'listDatasets',
            parameters: [
              {
                name: 'projectId',
                in: 'path',
                required: true,
                schema: {type: 'string'},
              },
            ],
            responses: {'200': {description: 'The datasets of the project.'}},
          },
        },
      },
    });

    function toolContext(): Context {
      return new Context({
        invocationContext: new InvocationContext({
          invocationId: 'inv-1',
          session: createSession({id: 'session-1', appName: 'app'}),
          pluginManager: new PluginManager(),
        }),
      });
    }

    it('sends the bearer token and the quota project header', async () => {
      googleAuthConstructor.mockImplementation(() =>
        fakeGoogleAuth({
          getClient: () =>
            Promise.resolve({
              getAccessToken: () => Promise.resolve({token: 'adc-token'}),
              quotaProjectId: 'quota-project',
            }),
        }),
      );
      const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          new Response('{}', {headers: {'content-type': 'application/json'}}),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const toolset = new OpenAPIToolset({
        specStr: GUIDE_SPEC,
        authCredential: credentialFor({
          useDefaultCredential: true,
          scopes: [BIGQUERY_SCOPE],
        }),
      });
      const [tool] = await toolset.getTools();
      await tool.runAsync({
        args: {projectId: 'my-project'},
        toolContext: toolContext(),
      });

      const [, request] = fetchMock.mock.calls[0];
      expect(request?.headers).toMatchObject({
        Authorization: 'Bearer adc-token',
        'x-goog-user-project': 'quota-project',
      });
    });
  });
});
