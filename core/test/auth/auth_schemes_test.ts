/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthScheme,
  AuthSchemeType,
  CustomAuthScheme,
  ExtendedOAuth2,
  OAuthGrantType,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {getOAuthGrantTypeFromFlow} from '../../src/auth/auth_schemes.js';

interface AcmeVaultScheme extends CustomAuthScheme {
  type: 'acmeVault';
  vaultPath: string;
}

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

  describe('AuthSchemeType', () => {
    // The values are OpenAPI 3.0 wire names and must match the reference enum
    // fastapi.openapi.models.SecuritySchemeType character for character.
    it('uses the OpenAPI wire name as each member value', () => {
      expect(AuthSchemeType.API_KEY).toBe('apiKey');
      expect(AuthSchemeType.HTTP).toBe('http');
      expect(AuthSchemeType.OAUTH2).toBe('oauth2');
      expect(AuthSchemeType.OPEN_ID_CONNECT).toBe('openIdConnect');
    });

    it('declares exactly the four OpenAPI security scheme types', () => {
      expect(Object.values(AuthSchemeType).sort()).toEqual([
        'apiKey',
        'http',
        'oauth2',
        'openIdConnect',
      ]);
    });

    it('is usable as the discriminant of an OpenAPI scheme', () => {
      const scheme: OpenAPIV3.ApiKeySecurityScheme = {
        type: AuthSchemeType.API_KEY,
        name: 'X-Api-Key',
        in: 'header',
      };

      expect(scheme.type).toBe(AuthSchemeType.API_KEY);
    });
  });

  describe('CustomAuthScheme', () => {
    it('widens an extending scheme to AuthScheme without a cast', () => {
      const acme: AcmeVaultScheme = {type: 'acmeVault', vaultPath: 'secret/db'};
      const scheme: AuthScheme = acme;

      expect(scheme.type).toBe('acmeVault');
    });

    it('keeps the fields the extending interface adds', () => {
      const acme: AcmeVaultScheme = {type: 'acmeVault', vaultPath: 'secret/db'};
      const scheme: AuthScheme = acme;

      expect(JSON.parse(JSON.stringify(scheme))).toEqual({
        type: 'acmeVault',
        vaultPath: 'secret/db',
      });
    });
  });

  describe('ExtendedOAuth2', () => {
    it('widens to AuthScheme and keeps the issuer URL', () => {
      const oauth2: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: 'https://issuer.example.com',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://issuer.example.com/auth',
            tokenUrl: 'https://issuer.example.com/token',
            scopes: {},
          },
        },
      };
      const scheme: AuthScheme = oauth2;

      expect(scheme.type).toBe('oauth2');
      expect(oauth2.issuerUrl).toBe('https://issuer.example.com');
    });

    it('leaves the issuer URL undefined when it is omitted', () => {
      const oauth2: ExtendedOAuth2 = {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://issuer.example.com/token',
            scopes: {},
          },
        },
      };

      expect(oauth2.issuerUrl).toBeUndefined();
    });
  });
});
