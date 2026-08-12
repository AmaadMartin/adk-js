/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthProviderRegistry,
  AuthScheme,
  BaseAuthProvider,
  OAuthGrantType,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {getOAuthGrantTypeFromFlow} from '../../src/auth/auth_schemes.js';
import {getTokenEndpoint} from '../../src/auth/oauth2/oauth2_utils.js';

class MockAuthProvider implements BaseAuthProvider {
  async getAuthCredential() {
    return undefined;
  }
}

const GCP_SCHEME: AuthScheme = {
  type: 'gcpAuthProviderScheme',
  name: 'projects/p/locations/l/authProviders/ap-1',
  scopes: ['https://www.googleapis.com/auth/bigquery'],
  continueUri: 'https://example.com/continue',
};

describe('auth_schemes', () => {
  describe('GcpAuthProviderScheme', () => {
    it('keeps the OAuth2 discriminant narrowing in getTokenEndpoint', () => {
      const oauth2Scheme: AuthScheme = {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/auth',
            tokenUrl: 'https://example.com/token',
            scopes: {},
          },
        },
      };

      expect(getTokenEndpoint(oauth2Scheme)).toBe('https://example.com/token');
    });

    it('is not mistaken for an OAuth2 scheme', () => {
      expect(getTokenEndpoint(GCP_SCHEME)).toBeUndefined();
    });

    it('dispatches through AuthProviderRegistry on its type', () => {
      const registry = new AuthProviderRegistry();
      const provider = new MockAuthProvider();
      registry.register('gcpAuthProviderScheme', provider);

      expect(registry.getProvider(GCP_SCHEME)).toBe(provider);
    });
  });

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
