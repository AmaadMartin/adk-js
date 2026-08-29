/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {
  AuthScheme,
  OpenIdConnectWithConfig,
} from '../../../src/auth/auth_schemes.js';
import {CredentialExchangeError} from '../../../src/auth/exchanger/base_credential_exchanger.js';
import {
  checkSchemeCredentialType,
  generateAuthToken,
  OAuth2BearerCredentialExchanger,
} from '../../../src/tools/openapi_tool/auth/credential_exchangers/oauth2_bearer_exchanger.js';

const TOKEN_ENDPOINT = 'https://example.com/token';
const ONE_HOUR_MS = 3600_000;

const authScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://example.com/auth',
  tokenEndpoint: TOKEN_ENDPOINT,
  scopes: ['openid', 'profile'],
} satisfies OpenIdConnectWithConfig;

const apiKeyScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
} satisfies OpenAPIV3.ApiKeySecurityScheme;

/** Builds an OAuth2 credential, overriding the fields a case cares about. */
function oauth2Credential(
  oauth2: AuthCredential['oauth2'] = {},
): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      ...oauth2,
    },
  };
}

/** Builds an expired credential that is ready to refresh. */
function expiredCredential(
  oauth2: AuthCredential['oauth2'] = {},
): AuthCredential {
  return oauth2Credential({
    accessToken: 'stale_access_token',
    refreshToken: 'test_refresh_token',
    expiresAt: Date.now() - ONE_HOUR_MS,
    ...oauth2,
  });
}

describe('checkSchemeCredentialType', () => {
  it('accepts an oauth2 credential with an openIdConnect scheme', () => {
    expect(() =>
      checkSchemeCredentialType({
        authScheme,
        authCredential: oauth2Credential({accessToken: 'test_access_token'}),
      }),
    ).not.toThrow();
  });

  it('throws when the credential is missing', () => {
    expect(() => checkSchemeCredentialType({authScheme})).toThrow(
      /auth_credential is empty\. Please create AuthCredential using OAuth2Auth\./,
    );
    expect(() => checkSchemeCredentialType({authScheme})).toThrow(
      CredentialExchangeError,
    );
  });

  it('reports the missing credential before the invalid scheme', () => {
    expect(() => checkSchemeCredentialType({authScheme: apiKeyScheme})).toThrow(
      /auth_credential is empty/,
    );
  });

  it('throws when the scheme type is not oauth2 or openIdConnect', () => {
    expect(() =>
      checkSchemeCredentialType({
        authScheme: apiKeyScheme,
        authCredential: oauth2Credential(),
      }),
    ).toThrow(
      /Invalid security scheme, expect openIdConnect or oauth2 auth scheme, but got apiKey/,
    );
  });

  it('throws when the scheme is missing', () => {
    expect(() =>
      checkSchemeCredentialType({authCredential: oauth2Credential()}),
    ).toThrow(/Invalid security scheme/);
  });

  it('throws when the credential has neither oauth2 nor http', () => {
    expect(() =>
      checkSchemeCredentialType({
        authScheme,
        authCredential: {authType: AuthCredentialTypes.OAUTH2},
      }),
    ).toThrow(
      /auth_credential is not configured with oauth2\. Please create AuthCredential and set OAuth2Auth\./,
    );
  });

  it('reports the invalid scheme before the missing oauth2 configuration', () => {
    expect(() =>
      checkSchemeCredentialType({
        authScheme: apiKeyScheme,
        authCredential: {authType: AuthCredentialTypes.OAUTH2},
      }),
    ).toThrow(/Invalid security scheme/);
  });
});

describe('generateAuthToken', () => {
  it('wraps the access token as an http bearer credential', () => {
    expect(generateAuthToken('test_access_token')).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_access_token'}},
    });
  });
});

describe('OAuth2BearerCredentialExchanger', () => {
  const fetchMock = vi.fn<typeof fetch>();

  /** Exchanges through the interface and returns the wrapped token. */
  async function exchange(
    scheme: AuthScheme | undefined,
    authCredential: AuthCredential,
  ) {
    return new OAuth2BearerCredentialExchanger().exchange({
      authScheme: scheme,
      authCredential,
    });
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts an access token into a bearer credential', async () => {
    const result = await exchange(
      authScheme,
      oauth2Credential({accessToken: 'test_access_token'}),
    );

    expect(result.wasExchanged).toBe(true);
    expect(result.credential).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_access_token'}},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the scheme is not an oauth2 scheme', async () => {
    await expect(
      exchange(
        apiKeyScheme,
        oauth2Credential({accessToken: 'test_access_token'}),
      ),
    ).rejects.toThrow(/Invalid security scheme/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the original credential when there is no access token', async () => {
    const authCredential = oauth2Credential({
      refreshToken: 'test_refresh_token',
    });

    const result = await exchange(authScheme, authCredential);

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toBe(authCredential);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an http credential through untouched', async () => {
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'existing_token'}},
    };

    const result = await exchange(authScheme, authCredential);

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toBe(authCredential);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not contact the token endpoint, even for an expired credential', async () => {
    const result = await exchange(authScheme, expiredCredential());

    // Refreshing belongs to ToolAuthHandler, which stores the refreshed
    // credential. This exchanger only wraps the token it is given.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('does not mutate the credential it is given', async () => {
    const authCredential = expiredCredential({
      accessToken: 'test_access_token',
    });

    await exchange(authScheme, authCredential);

    expect(authCredential.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(authCredential.oauth2?.accessToken).toBe('test_access_token');
    expect(authCredential.http).toBeUndefined();
  });
});
