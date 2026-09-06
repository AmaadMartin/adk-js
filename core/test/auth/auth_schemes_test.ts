/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExtendedOAuth2,
  isCustomAuthScheme,
  isExtendedOAuth2,
  isOAuth2Scheme,
  isOpenIdConnectWithConfig,
  OAuthGrantType,
  OpenIdConnectWithConfig,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {getOAuthGrantTypeFromFlow} from '../../src/auth/auth_schemes.js';

const AUTH_ENDPOINT = 'https://auth.example.com/authorize';
const TOKEN_ENDPOINT = 'https://auth.example.com/token';

const OAUTH2_SCHEME: OpenAPIV3.OAuth2SecurityScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: AUTH_ENDPOINT,
      tokenUrl: TOKEN_ENDPOINT,
      scopes: {},
    },
  },
};

const OIDC_SCHEME: OpenIdConnectWithConfig = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://auth.example.com',
  authorizationEndpoint: AUTH_ENDPOINT,
  tokenEndpoint: TOKEN_ENDPOINT,
};

describe('auth_schemes', () => {
  describe('getOAuthGrantTypeFromFlow', () => {
    it('returns CLIENT_CREDENTIALS when clientCredentials is present', () => {
      const flow = {
        clientCredentials: {
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      };
      expect(getOAuthGrantTypeFromFlow(flow)).toBe(
        OAuthGrantType.CLIENT_CREDENTIALS,
      );
    });

    it('returns AUTHORIZATION_CODE when authorizationCode is present', () => {
      const flow = {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      };
      expect(getOAuthGrantTypeFromFlow(flow)).toBe(
        OAuthGrantType.AUTHORIZATION_CODE,
      );
    });

    it('returns IMPLICIT when implicit is present', () => {
      const flow = {
        implicit: {
          authorizationUrl: 'https://example.com/auth',
          scopes: {},
        },
      };
      expect(getOAuthGrantTypeFromFlow(flow)).toBe(OAuthGrantType.IMPLICIT);
    });

    it('returns PASSWORD when password is present', () => {
      const flow = {
        password: {
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      };
      expect(getOAuthGrantTypeFromFlow(flow)).toBe(OAuthGrantType.PASSWORD);
    });

    it('returns undefined when no flow matches', () => {
      const flow = {};
      expect(getOAuthGrantTypeFromFlow(flow)).toBeUndefined();
    });
  });
});

describe('auth_schemes type guards', () => {
  describe('isCustomAuthScheme', () => {
    it.each(['apiKey', 'http', 'oauth2', 'openIdConnect'])(
      'returns false for the OpenAPI scheme type %s',
      (type) => {
        expect(isCustomAuthScheme({type})).toBe(false);
      },
    );

    it('returns true for a scheme type outside the OpenAPI set', () => {
      expect(isCustomAuthScheme({type: 'acmeVault'})).toBe(true);
    });
  });

  describe('isOAuth2Scheme', () => {
    it('returns true for an OAuth2 scheme that declares its flows', () => {
      expect(isOAuth2Scheme(OAUTH2_SCHEME)).toBe(true);
    });

    it('returns false for an OAuth2 scheme with no flows', () => {
      expect(isOAuth2Scheme({type: 'oauth2'})).toBe(false);
    });

    it('returns false for a scheme of another type', () => {
      expect(isOAuth2Scheme(OIDC_SCHEME)).toBe(false);
    });
  });

  describe('isExtendedOAuth2', () => {
    it('returns true when the scheme names a non-empty issuer', () => {
      const scheme: ExtendedOAuth2 = {
        ...OAUTH2_SCHEME,
        issuerUrl: 'https://auth.example.com',
      };
      expect(isExtendedOAuth2(scheme)).toBe(true);
    });

    it('returns false when the scheme names no issuer', () => {
      expect(isExtendedOAuth2(OAUTH2_SCHEME)).toBe(false);
    });

    it('returns false when the issuer is the empty string', () => {
      const scheme: ExtendedOAuth2 = {
        ...OAUTH2_SCHEME,
        issuerUrl: '',
      };
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('returns false for a scheme that is not OAuth2', () => {
      expect(isExtendedOAuth2(OIDC_SCHEME)).toBe(false);
    });
  });

  describe('isOpenIdConnectWithConfig', () => {
    it('returns true for an OIDC scheme carrying both endpoints', () => {
      expect(isOpenIdConnectWithConfig(OIDC_SCHEME)).toBe(true);
    });

    it('returns false for an OIDC scheme missing the token endpoint', () => {
      expect(
        isOpenIdConnectWithConfig({
          type: 'openIdConnect',
          openIdConnectUrl: 'https://auth.example.com',
          authorizationEndpoint: AUTH_ENDPOINT,
        }),
      ).toBe(false);
    });

    it('returns false for a scheme of another type', () => {
      expect(isOpenIdConnectWithConfig(OAUTH2_SCHEME)).toBe(false);
    });
  });
});
