/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../../../src/auth/auth_credential.js';
import {
  AuthScheme,
  OpenIdConnectWithConfig,
} from '../../../../../src/auth/auth_schemes.js';
import {
  OAuth2AuthCredential,
  OAuth2CredentialExchanger,
} from '../../../../../src/tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.js';

describe('OAuth2CredentialExchanger', () => {
  const openIdAuthScheme: OpenIdConnectWithConfig = {
    type: 'openIdConnect',
    openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
    authorizationEndpoint: 'https://example.com/oauth2/authorize',
    tokenEndpoint: 'https://example.com/oauth2/token',
    scopes: ['read', 'write'],
  };

  const oauth2AuthScheme: AuthScheme = {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://example.com/oauth2/authorize',
        tokenUrl: 'https://example.com/oauth2/token',
        scopes: {read: 'Read access'},
      },
    },
  };

  describe('_checkSchemeCredentialType', () => {
    it('succeeds for valid openIdConnect and oauth2 schemes with oauth2 or http credentials', () => {
      const exchanger = new OAuth2CredentialExchanger();
      const oauth2Credential: OAuth2AuthCredential = {
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {
          clientId: 'test_client_id',
          clientSecret: 'test_client_secret',
        },
      };
      const httpCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'existing_token'},
        },
      };

      expect(() =>
        exchanger._checkSchemeCredentialType(
          openIdAuthScheme,
          oauth2Credential,
        ),
      ).not.toThrow();
      expect(() =>
        exchanger._check_scheme_credential_type(
          oauth2AuthScheme,
          oauth2Credential,
        ),
      ).not.toThrow();
      expect(() =>
        exchanger._checkSchemeCredentialType(openIdAuthScheme, httpCredential),
      ).not.toThrow();
    });

    it('throws error when auth_credential is missing', () => {
      const exchanger = new OAuth2CredentialExchanger();
      expect(() =>
        exchanger._checkSchemeCredentialType(openIdAuthScheme, undefined),
      ).toThrow(
        'auth_credential is empty. Please create AuthCredential using OAuth2Auth.',
      );
      expect(() =>
        exchanger._check_scheme_credential_type(openIdAuthScheme, null),
      ).toThrow(
        'auth_credential is empty. Please create AuthCredential using OAuth2Auth.',
      );
    });

    it('throws error when auth_scheme type is invalid', () => {
      const exchanger = new OAuth2CredentialExchanger();
      const invalidScheme: AuthScheme = {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      };
      const authCredential: OAuth2AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'test_client_id',
        },
      };

      expect(() =>
        exchanger._checkSchemeCredentialType(invalidScheme, authCredential),
      ).toThrow(
        'Invalid security scheme, expect AuthSchemeType.openIdConnect or AuthSchemeType.oauth2 auth scheme, but got apiKey',
      );
    });

    it('throws error when auth_credential has neither oauth2 nor http configured', () => {
      const exchanger = new OAuth2CredentialExchanger();
      const invalidCredential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'some-key',
      };

      expect(() =>
        exchanger._checkSchemeCredentialType(
          openIdAuthScheme,
          invalidCredential,
        ),
      ).toThrow(
        'auth_credential is not configured with oauth2. Please create AuthCredential and set OAuth2Auth.',
      );
    });
  });

  describe('generateAuthToken', () => {
    it('generates an HTTP bearer credential when access_token is present in oauth2.token', () => {
      const exchanger = new OAuth2CredentialExchanger();
      const authCredential: OAuth2AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client_id',
          token: {
            access_token: 'test_access_token_123',
            token_type: 'Bearer',
          },
        },
      };

      const result = exchanger.generateAuthToken(authCredential);
      expect(result).toEqual({
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {
            token: 'test_access_token_123',
          },
        },
      });
    });

    it('returns original credential when access_token is not in oauth2.token', () => {
      const exchanger = new OAuth2CredentialExchanger();
      const authCredential: OAuth2AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client_id',
          token: {
            refresh_token: 'only_refresh_token',
          },
        },
      };

      const result = exchanger.generate_auth_token(authCredential);
      expect(result).toBe(authCredential);
    });
  });

  describe('exchangeCredential', () => {
    it('returns existing credential unchanged if http is already set', () => {
      const exchanger = new OAuth2CredentialExchanger();
      const httpCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {
            token: 'already_exchanged_token',
          },
        },
      };

      const result = exchanger.exchangeCredential(
        openIdAuthScheme,
        httpCredential,
      );
      expect(result).toBe(httpCredential);
    });

    it('exchanges oauth2 token into HTTP bearer credential', () => {
      const exchanger = new OAuth2CredentialExchanger();
      const oauth2Credential: OAuth2AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client_id',
          clientSecret: 'client_secret',
          token: {
            access_token: 'exchanged_bearer_token',
          },
        },
      };

      const result = exchanger.exchange_credential(
        oauth2AuthScheme,
        oauth2Credential,
      );
      expect(result).toEqual({
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {
            token: 'exchanged_bearer_token',
          },
        },
      });
    });

    it('returns null when oauth2.token is missing or empty', () => {
      const exchanger = new OAuth2CredentialExchanger();
      const credentialWithoutToken: OAuth2AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client_id',
          clientSecret: 'client_secret',
        },
      };

      expect(
        exchanger.exchangeCredential(oauth2AuthScheme, credentialWithoutToken),
      ).toBeNull();

      const credentialWithEmptyToken: OAuth2AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client_id',
          token: {},
        },
      };

      expect(
        exchanger.exchangeCredential(
          oauth2AuthScheme,
          credentialWithEmptyToken,
        ),
      ).toBeNull();
    });
  });
});
