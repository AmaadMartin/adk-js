/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {JWT} from 'google-auth-library';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {OpenIdConnectWithConfig} from '../../../src/auth/auth_schemes.js';
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

  it('should convert an oauth2 access token into a bearer credential', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'oauth2-access-token'},
    };
    const authScheme = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      authorizationEndpoint: 'https://example.com/auth',
      tokenEndpoint: 'https://example.com/token',
    } satisfies OpenIdConnectWithConfig;

    const result = await exchanger.exchange({
      authScheme,
      authCredential: credential,
    });

    expect(result.credential.http?.credentials.token).toBe(
      'oauth2-access-token',
    );
  });

  it('keeps the oauth2 data on the credential it returns', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const authScheme = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      authorizationEndpoint: 'https://example.com/auth',
      tokenEndpoint: 'https://example.com/token',
    } satisfies OpenIdConnectWithConfig;

    const result = await exchanger.exchange({
      authScheme,
      authCredential: {
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {
          accessToken: 'oauth2-access-token',
          refreshToken: 'oauth2-refresh-token',
        },
      },
    });

    // The caller stores this credential. A bearer credential on its own holds
    // no refresh token, so a later call could never renew the access token.
    expect(result.credential.oauth2?.refreshToken).toBe('oauth2-refresh-token');
    expect(result.credential.http?.credentials.token).toBe(
      'oauth2-access-token',
    );
  });

  it('reports no exchange when it only wraps a token it was given', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const authScheme = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
      authorizationEndpoint: 'https://example.com/auth',
      tokenEndpoint: 'https://example.com/token',
    } satisfies OpenIdConnectWithConfig;

    const result = await exchanger.exchange({
      authScheme,
      authCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          accessToken: 'oauth2-access-token',
        },
      },
    });

    // `ToolAuthHandler` persists on this flag, so a conversion that reached no
    // token endpoint must not report an exchange.
    expect(result.wasExchanged).toBe(false);
  });

  it('keeps the bearer token a tool was configured with under an oauth2 scheme', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const authScheme = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    } satisfies OpenAPIV3.OAuth2SecurityScheme;

    // The dispatcher routes on `authType`, so a tool configured with an OAuth2
    // scheme and a bearer token its owner already holds arrives here as an
    // OAuth2-typed credential carrying no oauth2 block.
    const result = await exchanger.exchange({
      authScheme,
      authCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        http: {scheme: 'bearer', credentials: {token: 'configured-token'}},
      },
    });

    expect(result.credential.http?.credentials.token).toBe('configured-token');
    expect(result.wasExchanged).toBe(false);
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
