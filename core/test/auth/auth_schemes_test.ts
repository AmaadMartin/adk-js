/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthScheme, CustomAuthScheme, OAuthGrantType} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getOAuthGrantTypeFromFlow,
  isOAuth2Scheme,
  isOpenIdConnectScheme,
} from '../../src/auth/auth_schemes.js';

interface AcmeVaultScheme extends CustomAuthScheme {
  type: 'acmeVault';
  vaultPath: string;
}

/** A custom scheme whose vendor payload happens to reuse the `flows` name. */
interface AcmeGatewayScheme extends CustomAuthScheme {
  type: 'acmeGateway';
  flows: Record<string, string>;
}

/** An oauth2 scheme whose `flows` key is present but carries no value. */
interface FlowlessOAuth2Scheme extends CustomAuthScheme {
  type: 'oauth2';
  flows: undefined;
}

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

const ACME_VAULT_SCHEME: AcmeVaultScheme = {
  type: 'acmeVault',
  vaultPath: 'secret/acme',
};

const ACME_GATEWAY_SCHEME: AcmeGatewayScheme = {
  type: 'acmeGateway',
  flows: {gateway: 'acme'},
};

const FLOWLESS_OAUTH2_SCHEME: FlowlessOAuth2Scheme = {
  type: 'oauth2',
  flows: undefined,
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

  describe('isOAuth2Scheme', () => {
    it('accepts an oauth2 scheme that declares flows', () => {
      expect(isOAuth2Scheme(OAUTH2_SCHEME)).toBe(true);
    });

    it('rejects a scheme whose type is oauth2 but which declares no flows', () => {
      const scheme: AuthScheme = {type: 'oauth2'};

      expect(isOAuth2Scheme(scheme)).toBe(false);
    });

    it('rejects an oauth2 scheme whose flows key carries no value', () => {
      expect(isOAuth2Scheme(FLOWLESS_OAUTH2_SCHEME)).toBe(false);
    });

    it('rejects a custom scheme that carries a flows property', () => {
      expect(isOAuth2Scheme(ACME_GATEWAY_SCHEME)).toBe(false);
    });

    it('rejects a custom scheme', () => {
      expect(isOAuth2Scheme(ACME_VAULT_SCHEME)).toBe(false);
    });

    it('rejects an openIdConnect scheme', () => {
      expect(isOAuth2Scheme(OPEN_ID_CONNECT_SCHEME)).toBe(false);
    });

    it('rejects an apiKey scheme', () => {
      expect(isOAuth2Scheme(API_KEY_SCHEME)).toBe(false);
    });
  });

  describe('CustomAuthScheme', () => {
    it('accepts an extending interface as an AuthScheme with its extra fields intact', () => {
      const scheme: AuthScheme = ACME_VAULT_SCHEME;

      expect(scheme).toEqual({type: 'acmeVault', vaultPath: 'secret/acme'});
    });
  });
});
