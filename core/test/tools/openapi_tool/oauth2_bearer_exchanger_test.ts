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
import {logger} from '../../../src/utils/logger.js';

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

/** An oauth2 scheme whose flows declare no token URL. */
const endpointlessScheme = {
  type: 'oauth2',
  flows: {},
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

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {status: 200});
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

  it('refreshes an expired access token before wrapping it', async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({access_token: 'refreshed_access_token', expires_in: 3600}),
    );

    const result = await exchange(authScheme, expiredCredential());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('test_refresh_token');
    expect(body.get('client_id')).toBe('test-client-id');
    expect(result.credential.http?.credentials.token).toBe(
      'refreshed_access_token',
    );
  });

  it('keeps the stale token when the token request rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await exchange(authScheme, expiredCredential());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('keeps the stale token when the token endpoint returns an error status', async () => {
    fetchMock.mockResolvedValue(new Response('{}', {status: 500}));

    const result = await exchange(authScheme, expiredCredential());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('keeps the stale token when the token request rejects with a non-error', async () => {
    fetchMock.mockRejectedValue('refresh unavailable');

    const result = await exchange(authScheme, expiredCredential());

    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('keeps the stale token when the refresh response omits the access token', async () => {
    fetchMock.mockResolvedValue(tokenResponse({expires_in: 3600}));

    const result = await exchange(authScheme, expiredCredential());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('does not refresh a token that is still valid', async () => {
    const result = await exchange(
      authScheme,
      expiredCredential({
        accessToken: 'valid_access_token',
        expiresAt: Date.now() + ONE_HOUR_MS,
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'valid_access_token',
    );
  });

  it('does not refresh an expired token without a refresh token', async () => {
    const result = await exchange(
      authScheme,
      oauth2Credential({
        accessToken: 'stale_access_token',
        expiresAt: Date.now() - ONE_HOUR_MS,
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('does not refresh when the scheme declares no token endpoint', async () => {
    const result = await exchange(endpointlessScheme, expiredCredential());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('does not refresh without a client id', async () => {
    const result = await exchange(
      authScheme,
      expiredCredential({clientId: undefined}),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('does not refresh without a client secret', async () => {
    const result = await exchange(
      authScheme,
      expiredCredential({clientSecret: undefined}),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('does not warn about a missing refresh token on a healthy call', async () => {
    const warn = vi.spyOn(logger, 'warn');

    await exchange(
      authScheme,
      oauth2Credential({accessToken: 'valid_access_token'}),
    );

    expect(warn).not.toHaveBeenCalledWith(
      'No refresh token available to refresh credential',
    );
    warn.mockRestore();
  });

  it('does not mutate the credential it is given', async () => {
    const authCredential = expiredCredential({
      accessToken: 'test_access_token',
    });
    fetchMock.mockResolvedValue(
      tokenResponse({access_token: 'refreshed_access_token'}),
    );

    await exchange(authScheme, authCredential);

    expect(authCredential.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(authCredential.oauth2?.accessToken).toBe('test_access_token');
    expect(authCredential.http).toBeUndefined();
  });
});
