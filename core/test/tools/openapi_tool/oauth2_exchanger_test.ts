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
import {OpenIdConnectWithConfig} from '../../../src/auth/auth_schemes.js';
import {CredentialExchangeError} from '../../../src/auth/exchanger/base_credential_exchanger.js';
import {
  checkSchemeCredentialType,
  generateAuthToken,
  OAuth2CredentialExchanger,
} from '../../../src/tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.js';
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

function tokenResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe('checkSchemeCredentialType', () => {
  it('accepts an oauth2 credential with an openIdConnect scheme', () => {
    expect(() =>
      checkSchemeCredentialType(
        authScheme,
        oauth2Credential({accessToken: 'test_access_token'}),
      ),
    ).not.toThrow();
  });

  it('throws when the scheme type is not oauth2 or openIdConnect', () => {
    expect(() =>
      checkSchemeCredentialType(apiKeyScheme, oauth2Credential()),
    ).toThrow(/Invalid security scheme, expected 'oauth2' or 'openIdConnect'/);
    expect(() =>
      checkSchemeCredentialType(apiKeyScheme, oauth2Credential()),
    ).toThrow(CredentialExchangeError);
  });

  it('throws when the scheme is missing', () => {
    expect(() =>
      checkSchemeCredentialType(undefined, oauth2Credential()),
    ).toThrow(/Invalid security scheme/);
  });

  it('throws when the credential has neither oauth2 nor http', () => {
    expect(() =>
      checkSchemeCredentialType(authScheme, {
        authType: AuthCredentialTypes.OAUTH2,
      }),
    ).toThrow(/not configured with oauth2/);
  });

  it('reports the invalid scheme before the missing oauth2 configuration', () => {
    expect(() =>
      checkSchemeCredentialType(apiKeyScheme, {
        authType: AuthCredentialTypes.OAUTH2,
      }),
    ).toThrow(/Invalid security scheme/);
  });
});

describe('generateAuthToken', () => {
  it('wraps the access token as an http bearer credential', () => {
    const result = generateAuthToken(
      oauth2Credential({accessToken: 'test_access_token'}),
    );

    expect(result).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_access_token'}},
    });
  });

  it('returns the credential unchanged when there is no access token', () => {
    const credential = oauth2Credential();

    expect(generateAuthToken(credential)).toBe(credential);
  });
});

describe('OAuth2CredentialExchanger', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts an access token into a bearer credential', async () => {
    const result = await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: oauth2Credential({accessToken: 'test_access_token'}),
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_access_token'}},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the scheme is not an oauth2 scheme', async () => {
    const exchanger = new OAuth2CredentialExchanger();

    await expect(
      exchanger.exchange({
        authScheme: apiKeyScheme,
        authCredential: oauth2Credential({accessToken: 'test_access_token'}),
      }),
    ).rejects.toThrow(/Invalid security scheme/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an http credential through untouched', async () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'existing_token'}},
    };

    const result = await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: credential,
    });

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toBe(credential);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the credential unchanged when it has no access token', async () => {
    const credential = oauth2Credential({refreshToken: 'test_refresh_token'});

    const result = await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: credential,
    });

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toBe(credential);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token before wrapping it', async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({
        access_token: 'refreshed_access_token',
        expires_in: 3600,
      }),
    );

    const result = await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: oauth2Credential({
        accessToken: 'stale_access_token',
        refreshToken: 'test_refresh_token',
        expiresAt: Date.now() - ONE_HOUR_MS,
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('test_refresh_token');
    expect(result.credential.http?.credentials.token).toBe(
      'refreshed_access_token',
    );
    expect(result.wasExchanged).toBe(true);
  });

  it('keeps the stale token when the token request rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: oauth2Credential({
        accessToken: 'stale_access_token',
        refreshToken: 'test_refresh_token',
        expiresAt: Date.now() - ONE_HOUR_MS,
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.credential).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'stale_access_token'}},
    });
  });

  it('keeps the stale token when the token endpoint returns an error status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const result = await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: oauth2Credential({
        accessToken: 'stale_access_token',
        refreshToken: 'test_refresh_token',
        expiresAt: Date.now() - ONE_HOUR_MS,
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.credential).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'stale_access_token'}},
    });
  });

  it('does not refresh a token that is still valid', async () => {
    const result = await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: oauth2Credential({
        accessToken: 'valid_access_token',
        refreshToken: 'test_refresh_token',
        expiresAt: Date.now() + ONE_HOUR_MS,
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'valid_access_token',
    );
  });

  it('does not refresh an expired token without a refresh token', async () => {
    const result = await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: oauth2Credential({
        accessToken: 'stale_access_token',
        expiresAt: Date.now() - ONE_HOUR_MS,
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials.token).toBe(
      'stale_access_token',
    );
  });

  it('does not warn about a missing refresh token on a healthy call', async () => {
    const warn = vi.spyOn(logger, 'warn');

    await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: oauth2Credential({accessToken: 'valid_access_token'}),
    });

    expect(warn).not.toHaveBeenCalledWith(
      'No refresh token available to refresh credential',
    );
    warn.mockRestore();
  });

  it('does not mutate the credential it is given', async () => {
    const credential = oauth2Credential({
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      expiresAt: Date.now() - ONE_HOUR_MS,
    });
    fetchMock.mockResolvedValue(
      tokenResponse({access_token: 'refreshed_access_token'}),
    );

    await new OAuth2CredentialExchanger().exchange({
      authScheme,
      authCredential: credential,
    });

    expect(credential.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(credential.oauth2?.accessToken).toBe('test_access_token');
    expect(credential.http).toBeUndefined();
  });
});
