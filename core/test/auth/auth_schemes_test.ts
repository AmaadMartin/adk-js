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
  isCustomAuthScheme,
  isExtendedOAuth2,
  isOAuth2Scheme,
  OAuthGrantType,
  OpenIdConnectWithConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {getOAuthGrantTypeFromFlow} from '../../src/auth/auth_schemes.js';

/** A custom scheme declared the way an external provider would declare one. */
interface ProviderScheme extends CustomAuthScheme {
  type: 'myProviderScheme';
  name: string;
  scopes?: string[];
}

const providerScheme: ProviderScheme = {
  type: 'myProviderScheme',
  name: 'my-provider',
  scopes: ['read'],
};

const oidcScheme: OpenIdConnectWithConfig = {
  type: 'openIdConnect',
  openIdConnectUrl:
    'https://issuer.example.com/.well-known/openid-configuration',
  authorizationEndpoint: 'https://issuer.example.com/auth',
  tokenEndpoint: 'https://issuer.example.com/token',
};

const oauth2Scheme: AuthScheme = {
  type: 'oauth2',
  flows: {
    clientCredentials: {tokenUrl: 'https://example.com/token', scopes: {}},
  },
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

  describe('wire values', () => {
    it('keeps the OpenAPI security scheme type names', () => {
      expect(AuthSchemeType.API_KEY).toBe('apiKey');
      expect(AuthSchemeType.HTTP).toBe('http');
      expect(AuthSchemeType.OAUTH2).toBe('oauth2');
      expect(AuthSchemeType.OPEN_ID_CONNECT).toBe('openIdConnect');
    });

    it('keeps the OAuth2 grant type names', () => {
      expect(OAuthGrantType.CLIENT_CREDENTIALS).toBe('client_credentials');
      expect(OAuthGrantType.AUTHORIZATION_CODE).toBe('authorization_code');
      expect(OAuthGrantType.IMPLICIT).toBe('implicit');
      expect(OAuthGrantType.PASSWORD).toBe('password');
    });
  });

  describe('isCustomAuthScheme', () => {
    it('accepts a scheme type outside the OpenAPI set', () => {
      expect(isCustomAuthScheme({type: 'myProviderScheme'})).toBe(true);
    });

    it('accepts a custom scheme that carries its own fields', () => {
      const scheme: AuthScheme = providerScheme;
      expect(isCustomAuthScheme(scheme)).toBe(true);
    });

    it('accepts an empty scheme type', () => {
      expect(isCustomAuthScheme({type: ''})).toBe(true);
    });

    it('rejects each OpenAPI scheme type', () => {
      for (const type of Object.values(AuthSchemeType)) {
        expect(isCustomAuthScheme({type})).toBe(false);
      }
    });

    it('rejects an OpenIdConnectWithConfig scheme', () => {
      expect(isCustomAuthScheme(oidcScheme)).toBe(false);
    });
  });

  describe('isOAuth2Scheme', () => {
    it('accepts an OAuth2 scheme that declares flows', () => {
      expect(isOAuth2Scheme(oauth2Scheme)).toBe(true);
    });

    it('rejects an OAuth2 scheme type with no flows', () => {
      expect(isOAuth2Scheme({type: 'oauth2'})).toBe(false);
    });

    it('rejects an OAuth2 scheme whose flows are undefined', () => {
      interface UnconfiguredOAuth2 extends CustomAuthScheme {
        type: 'oauth2';
        flows: undefined;
      }
      const scheme: UnconfiguredOAuth2 = {type: 'oauth2', flows: undefined};
      expect(isOAuth2Scheme(scheme)).toBe(false);
    });

    it('rejects an OpenIdConnectWithConfig scheme', () => {
      expect(isOAuth2Scheme(oidcScheme)).toBe(false);
    });

    it('rejects an apiKey scheme', () => {
      expect(
        isOAuth2Scheme({type: 'apiKey', name: 'x-api-key', in: 'header'}),
      ).toBe(false);
    });

    it('rejects a custom scheme', () => {
      expect(isOAuth2Scheme(providerScheme)).toBe(false);
    });
  });

  describe('isExtendedOAuth2', () => {
    it('accepts an OAuth2 scheme that carries an issuer', () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: 'https://issuer.example.com',
        flows: {},
      };
      expect(isExtendedOAuth2(scheme)).toBe(true);
    });

    it('rejects an OAuth2 scheme with no issuer', () => {
      expect(isExtendedOAuth2(oauth2Scheme)).toBe(false);
    });

    it('rejects an issuer that is present but undefined', () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: undefined,
        flows: {},
      };
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('rejects an empty issuer', () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: '',
        flows: {},
      };
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });

    it('rejects a custom scheme that carries an issuer', () => {
      interface IssuerBearingScheme extends CustomAuthScheme {
        type: 'myProviderScheme';
        issuerUrl: string;
      }
      const scheme: IssuerBearingScheme = {
        type: 'myProviderScheme',
        issuerUrl: 'https://issuer.example.com',
      };
      expect(isExtendedOAuth2(scheme)).toBe(false);
    });
  });

  describe('AuthScheme union', () => {
    it('admits a custom scheme and keeps its fields typed', () => {
      const scheme: AuthScheme = providerScheme;
      expect(isCustomAuthScheme(scheme) && scheme.type).toBe(
        'myProviderScheme',
      );
      expect(providerScheme.name).toBe('my-provider');
    });
  });
});
