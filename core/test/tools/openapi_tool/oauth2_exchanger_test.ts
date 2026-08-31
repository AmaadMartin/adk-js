/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  CredentialExchangeError,
  OpenIdConnectWithConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  checkSchemeCredentialType,
  generateAuthToken,
  OAuth2CredentialExchanger,
} from '../../../src/tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.js';

function createExchanger(): OAuth2CredentialExchanger {
  return new OAuth2CredentialExchanger();
}

function createAuthScheme(): OpenIdConnectWithConfig {
  return {
    type: 'openIdConnect',
    openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
    authorizationEndpoint: 'https://example.com/auth',
    tokenEndpoint: 'https://example.com/token',
    scopes: ['openid', 'profile'],
  };
}

/** An OAuth2 credential whose authorization flow has not completed yet. */
function createOAuth2Credential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'test_client',
      clientSecret: 'test_secret',
      redirectUri: 'http://localhost:8080',
    },
  };
}

/** An OAuth2 credential that already holds an access token. */
function createAcquiredCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'test_client',
      clientSecret: 'test_secret',
      redirectUri: 'http://localhost:8080',
      authResponseUri: 'https://example.com/callback?code=test_code',
      accessToken: 'test_access_token',
    },
  };
}

describe('checkSchemeCredentialType', () => {
  it('accepts an openIdConnect scheme with an oauth2 credential', () => {
    expect(() =>
      checkSchemeCredentialType(createAuthScheme(), createOAuth2Credential()),
    ).not.toThrow();
  });

  it('throws when the credential is missing', () => {
    const check = () =>
      checkSchemeCredentialType(createAuthScheme(), undefined);

    expect(check).toThrow(CredentialExchangeError);
    expect(check).toThrow(/authCredential is empty/);
  });

  it('throws when the scheme is not openIdConnect or oauth2', () => {
    const apiKeyScheme: AuthScheme = {
      type: 'apiKey',
      name: 'x',
      in: 'header',
    };
    const check = () =>
      checkSchemeCredentialType(apiKeyScheme, createOAuth2Credential());

    expect(check).toThrow(CredentialExchangeError);
    expect(check).toThrow(/Invalid security scheme/);
  });

  it('throws when the credential carries neither oauth2 nor http', () => {
    const check = () =>
      checkSchemeCredentialType(createAuthScheme(), {
        authType: AuthCredentialTypes.OAUTH2,
      });

    expect(check).toThrow(CredentialExchangeError);
    expect(check).toThrow(/authCredential is not configured with oauth2/);
  });
});

describe('OAuth2CredentialExchanger', () => {
  it('generateAuthToken wraps the access token as an http bearer credential', () => {
    const credential = generateAuthToken(createAcquiredCredential());

    expect(credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(credential.http?.scheme).toBe('bearer');
    expect(credential.http?.credentials.token).toBe('test_access_token');
  });

  it('exchange converts an acquired access token into a bearer credential', async () => {
    const result = await createExchanger().exchange({
      authScheme: createAuthScheme(),
      authCredential: createAcquiredCredential(),
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(result.credential.http?.scheme).toBe('bearer');
    expect(result.credential.http?.credentials.token).toBe('test_access_token');
  });

  it('exchange rejects when the credential is missing', async () => {
    const exchange = () =>
      createExchanger().exchange({
        authScheme: createAuthScheme(),
        authCredential: undefined as unknown as AuthCredential,
      });

    await expect(exchange()).rejects.toThrow(CredentialExchangeError);
    await expect(exchange()).rejects.toThrow(/authCredential is empty/);
  });
});
