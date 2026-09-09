/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthScheme,
  CustomAuthScheme,
  isCustomAuthScheme,
  OAuthGrantType,
  OpenIdConnectWithConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {getOAuthGrantTypeFromFlow} from '../../src/auth/auth_schemes.js';

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

  describe('isCustomAuthScheme', () => {
    it('rejects an apiKey scheme', () => {
      const scheme: AuthScheme = {type: 'apiKey', name: 'key', in: 'header'};
      expect(isCustomAuthScheme(scheme)).toBe(false);
    });

    it('rejects an http scheme', () => {
      const scheme: AuthScheme = {type: 'http', scheme: 'bearer'};
      expect(isCustomAuthScheme(scheme)).toBe(false);
    });

    it('rejects an oauth2 scheme', () => {
      const scheme: AuthScheme = {
        type: 'oauth2',
        flows: {
          implicit: {authorizationUrl: 'https://example.com/auth', scopes: {}},
        },
      };
      expect(isCustomAuthScheme(scheme)).toBe(false);
    });

    it('rejects an openIdConnect scheme', () => {
      const scheme: AuthScheme = {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
      };
      expect(isCustomAuthScheme(scheme)).toBe(false);
    });

    it('rejects an OpenIdConnectWithConfig scheme', () => {
      const scheme: OpenIdConnectWithConfig = {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
        authorizationEndpoint: 'https://example.com/auth',
        tokenEndpoint: 'https://example.com/token',
      };
      expect(isCustomAuthScheme(scheme)).toBe(false);
    });

    it('accepts the Agent Registry gcpAuthProviderScheme', () => {
      const scheme: CustomAuthScheme = {type: 'gcpAuthProviderScheme'};
      expect(isCustomAuthScheme(scheme)).toBe(true);
    });

    it('accepts an arbitrary unknown scheme type', () => {
      const scheme: CustomAuthScheme = {type: 'myTokenScheme'};
      expect(isCustomAuthScheme(scheme)).toBe(true);
    });
  });
});
