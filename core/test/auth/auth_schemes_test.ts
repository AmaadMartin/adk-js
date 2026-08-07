/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthScheme, OAuthGrantType} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getOAuthGrantTypeFromFlow,
  isOpenIdConnectScheme,
} from '../../src/auth/auth_schemes.js';

const OAUTH2_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    clientCredentials: {tokenUrl: 'https://example.com/token', scopes: {}},
  },
};

const OPEN_ID_CONNECT_SCHEME: AuthScheme = {
  type: 'openIdConnect',
  openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://example.com/auth',
  tokenEndpoint: 'https://example.com/token',
};

const HTTP_SCHEME: AuthScheme = {type: 'http', scheme: 'bearer'};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
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

  describe('isOpenIdConnectScheme', () => {
    it('accepts a scheme whose type is openIdConnect', () => {
      expect(isOpenIdConnectScheme(OPEN_ID_CONNECT_SCHEME)).toBe(true);
    });

    it('accepts an openIdConnect scheme that carries no configuration fields', () => {
      const scheme: AuthScheme = {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
      };

      expect(isOpenIdConnectScheme(scheme)).toBe(true);
    });

    it('rejects an oauth2 scheme', () => {
      expect(isOpenIdConnectScheme(OAUTH2_SCHEME)).toBe(false);
    });

    it('rejects an http scheme', () => {
      expect(isOpenIdConnectScheme(HTTP_SCHEME)).toBe(false);
    });

    it('rejects an apiKey scheme', () => {
      expect(isOpenIdConnectScheme(API_KEY_SCHEME)).toBe(false);
    });

    it('rejects an http scheme that carries a grantTypesSupported property', () => {
      const scheme = {
        type: 'http' as const,
        scheme: 'bearer',
        grantTypesSupported: ['client_credentials'],
      };

      expect(isOpenIdConnectScheme(scheme)).toBe(false);
    });
  });
});
