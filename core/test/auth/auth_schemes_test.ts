/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthScheme, OAuthGrantType} from '@google/adk';
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
    it('returns true for an oauth2 scheme carrying an issuer URL', () => {
      const scheme: AuthScheme = {
        type: 'oauth2',
        issuerUrl: 'https://auth.example.com',
        flows: {},
      };
      expect(isExtendedOAuth2(scheme)).toBe(true);
    });

    it('returns false for an oauth2 scheme without an issuer URL', () => {
      const scheme: AuthScheme = {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
            scopes: {},
          },
        },
      };
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('returns false for a non-oauth2 scheme that carries an issuerUrl', () => {
      // An apiKey scheme is not an OAuth2 scheme, whatever extra properties a
      // user configuration puts on it.
      const scheme: AuthScheme = JSON.parse(
        '{"type":"apiKey","name":"X-API-Key","in":"header","issuerUrl":"https://auth.example.com"}',
      );
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('narrows the scheme so issuerUrl is readable without a cast', () => {
      const scheme: AuthScheme = {
        type: 'oauth2',
        issuerUrl: 'https://auth.example.com',
        flows: {},
      };

      if (!isExtendedOAuth2(scheme)) {
        expect.fail('expected the scheme to narrow to ExtendedOAuth2');
      }
      expect(scheme.issuerUrl).toBe('https://auth.example.com');
    });
  });
});
