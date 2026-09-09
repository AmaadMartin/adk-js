/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthScheme, ExtendedOAuth2, OAuthGrantType} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getOAuthGrantTypeFromFlow,
  isExtendedOAuth2,
} from '../../src/auth/auth_schemes.js';

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

  describe('isExtendedOAuth2', () => {
    it('returns true for an OAuth2 scheme carrying an issuerUrl', () => {
      // Typing the literal as AuthScheme also pins the union widening: an
      // issuerUrl fails the excess-property check without it.
      const scheme: AuthScheme = {
        type: 'oauth2',
        issuerUrl: 'https://auth.example.com',
        flows: {
          authorizationCode: {
            authorizationUrl: '',
            tokenUrl: '',
            scopes: {read: 'Read access'},
          },
        },
      };
      expect(isExtendedOAuth2(scheme)).toBe(true);
    });

    it('returns false for an OAuth2 scheme without an issuerUrl', () => {
      const scheme: ExtendedOAuth2 = {type: 'oauth2', flows: {}};
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('returns false for an empty issuerUrl', () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: '',
        flows: {},
      };
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('returns false for an openIdConnect scheme carrying an issuerUrl', () => {
      const scheme = {
        type: 'openIdConnect' as const,
        openIdConnectUrl:
          'https://auth.example.com/.well-known/openid-configuration',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        issuerUrl: 'https://auth.example.com',
      };
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('returns false for an apiKey scheme', () => {
      const scheme: AuthScheme = {type: 'apiKey', name: 'X-Key', in: 'header'};
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('returns false for an undefined scheme', () => {
      expect(isExtendedOAuth2(undefined)).toBe(false);
    });
  });
});
