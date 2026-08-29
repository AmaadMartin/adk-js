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
import {OAuth2RefreshingBearerExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/oauth2_bearer_exchanger.js';

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

/** An OAuth2 scheme whose flows resolve to an acquisition grant type. */
const authorizationCodeScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: TOKEN_ENDPOINT,
      scopes: {},
    },
  },
} satisfies OpenAPIV3.OAuth2SecurityScheme;

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

describe('OAuth2RefreshingBearerExchanger', () => {
  const fetchMock = vi.fn<typeof fetch>();

  /** Exchanges through the interface and returns the wrapped token. */
  async function exchange(
    scheme: AuthScheme | undefined,
    authCredential: AuthCredential,
  ) {
    return new OAuth2RefreshingBearerExchanger().exchange({
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

    // Wrapping a token the credential already holds reaches no token
    // endpoint, and `ToolAuthHandler` persists the credential on this flag.
    expect(result.wasExchanged).toBe(false);
    expect(result.credential.http).toEqual({
      scheme: 'bearer',
      credentials: {token: 'test_access_token'},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the scheme is not an oauth2 scheme', async () => {
    await expect(
      exchange(
        apiKeyScheme,
        oauth2Credential({accessToken: 'test_access_token'}),
      ),
    ).rejects.toThrow(
      /Invalid security scheme, expect openIdConnect or oauth2 auth scheme, but got apiKey/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the scheme is missing', async () => {
    const promise = exchange(
      undefined,
      oauth2Credential({accessToken: 'test_access_token'}),
    );

    await expect(promise).rejects.toThrow(CredentialExchangeError);
    await expect(promise).rejects.toThrow(/Invalid security scheme/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a credential that carries neither oauth2 nor http', async () => {
    await expect(
      exchange(authScheme, {authType: AuthCredentialTypes.OAUTH2}),
    ).rejects.toThrow(
      /auth_credential is not configured with oauth2\. Please create AuthCredential and set OAuth2Auth\./,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the invalid scheme before the missing oauth2 configuration', async () => {
    await expect(
      exchange(apiKeyScheme, {authType: AuthCredentialTypes.OAUTH2}),
    ).rejects.toThrow(/Invalid security scheme/);
  });

  it('returns the original credential when there is no access token', async () => {
    const authCredential = oauth2Credential({
      refreshToken: 'test_refresh_token',
    });

    const result = await exchange(authScheme, authCredential);

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toEqual(authCredential);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an http credential through untouched', async () => {
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'existing_token'}},
    };

    const result = await exchange(authScheme, authCredential);

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toEqual(authCredential);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a tool-configured bearer token through a scheme that declares flows', async () => {
    // The shape a tool configured with an OAuth2 scheme and a bearer token
    // reaches this exchanger with: `AutoAuthCredentialExchanger` routes on
    // `authType`, so the credential is OAuth2-typed and carries no oauth2
    // block. A scheme with flows resolves to a grant type, so the acquisition
    // delegate rejects it for the OAuth2 client it does not hold.
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      http: {scheme: 'bearer', credentials: {token: 'existing_token'}},
    };

    const result = await exchange(authorizationCodeScheme, authCredential);

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toEqual(authCredential);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not contact the token endpoint for an expired credential that carries no refresh token', async () => {
    const result = await exchange(
      authScheme,
      expiredCredential({refreshToken: undefined}),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('does not mutate the credential it is given', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh_access_token',
        expires_in: 3600,
      }),
    } as Response);
    const authCredential = expiredCredential({
      accessToken: 'test_access_token',
    });

    await exchange(authScheme, authCredential);

    expect(authCredential.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(authCredential.oauth2?.accessToken).toBe('test_access_token');
    expect(authCredential.http).toBeUndefined();
  });

  it('refreshes an expired token before it wraps it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh_access_token',
        expires_in: 3600,
      }),
    } as Response);

    const result = await exchange(authScheme, expiredCredential());

    expect(result.credential.http?.credentials.token).toBe(
      'fresh_access_token',
    );
    // The caller stores this credential, so it must carry the tokens the
    // refresh returned rather than the ones it replaced.
    expect(result.credential.oauth2?.accessToken).toBe('fresh_access_token');
    expect(result.wasExchanged).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_ENDPOINT, expect.anything());
  });
});
