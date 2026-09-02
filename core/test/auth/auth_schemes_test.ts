/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthScheme,
  AuthSchemeType,
  CustomAuthScheme,
  OAuthGrantType,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, expectTypeOf, it} from 'vitest';
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

    // A compile-time claim: tsc fails this case, the runner cannot.
    it('types each member as the discriminant of its OpenAPI scheme', () => {
      expectTypeOf<AuthSchemeType.API_KEY>().toExtend<
        OpenAPIV3.ApiKeySecurityScheme['type']
      >();
      expectTypeOf<AuthSchemeType.HTTP>().toExtend<
        OpenAPIV3.HttpSecurityScheme['type']
      >();
      expectTypeOf<AuthSchemeType.OAUTH2>().toExtend<
        OpenAPIV3.OAuth2SecurityScheme['type']
      >();
      expectTypeOf<AuthSchemeType.OPEN_ID_CONNECT>().toExtend<
        OpenAPIV3.OpenIdSecurityScheme['type']
      >();
    });
  });

  describe('CustomAuthScheme', () => {
    // Compile-time claims: tsc fails these cases, the runner cannot.
    it('is a member of the AuthScheme union', () => {
      expectTypeOf<CustomAuthScheme>().toExtend<AuthScheme>();
    });

    it('makes an extending scheme an AuthScheme without a cast', () => {
      expectTypeOf<AcmeVaultScheme>().toExtend<AuthScheme>();
    });

    it('leaves the fields the extending interface adds', () => {
      expectTypeOf<AcmeVaultScheme>()
        .toHaveProperty('vaultPath')
        .toEqualTypeOf<string>();
    });
  });
});
