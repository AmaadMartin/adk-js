/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, AuthCredentialTypes, AuthScheme} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {buildAuthHeaders} from '../../src/auth/auth_headers.js';

const API_KEY_HEADER_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-Api-Key',
  in: 'header',
};

const API_KEY_QUERY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'api_key',
  in: 'query',
};

const HTTP_BEARER_SCHEME: AuthScheme = {type: 'http', scheme: 'bearer'};

describe('buildAuthHeaders', () => {
  it('returns undefined with no credential', () => {
    expect(buildAuthHeaders(undefined, API_KEY_HEADER_SCHEME)).toBeUndefined();
  });

  it('returns undefined for a credential carrying nothing usable', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  describe('oauth2', () => {
    it('sends the access token as a bearer header', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'token-abc'},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer token-abc',
      });
    });

    it('returns undefined when the exchange produced no access token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      };

      expect(buildAuthHeaders(credential)).toBeUndefined();
    });
  });

  describe('http', () => {
    it('sends a bearer token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Bearer', credentials: {token: 'tok'}},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer tok',
      });
    });

    it('base64 encodes basic credentials', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'basic',
          credentials: {username: 'user', password: 'pass'},
        },
      };

      expect(buildAuthHeaders(credential)).toEqual({
        // base64('user:pass')
        Authorization: 'Basic dXNlcjpwYXNz',
      });
    });

    it('returns undefined for basic auth missing a password', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'user'}},
      };

      expect(buildAuthHeaders(credential)).toBeUndefined();
    });

    it('keeps the configured spelling of a non-standard scheme', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Token', credentials: {token: 'tok'}},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Token tok',
      });
    });

    it('returns undefined for a token-less non-basic scheme', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {}},
      };

      expect(buildAuthHeaders(credential)).toBeUndefined();
    });

    it('merges additional headers alongside the authorization header', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'tok'},
          additionalHeaders: {'X-Tenant': 'acme'},
        },
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer tok',
        'X-Tenant': 'acme',
      });
    });

    it('sends additional headers on their own when there is no token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {},
          additionalHeaders: {'X-Tenant': 'acme'},
        },
      };

      expect(buildAuthHeaders(credential)).toEqual({'X-Tenant': 'acme'});
    });
  });

  describe('apiKey', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-key',
    };

    it('names the header from a header-located scheme', () => {
      expect(buildAuthHeaders(credential, API_KEY_HEADER_SCHEME)).toEqual({
        'X-Api-Key': 'secret-key',
      });
    });

    it('refuses a query-located scheme', () => {
      expect(
        buildAuthHeaders(credential, API_KEY_QUERY_SCHEME),
      ).toBeUndefined();
    });

    it('refuses a scheme that names no header', () => {
      expect(buildAuthHeaders(credential, HTTP_BEARER_SCHEME)).toBeUndefined();
    });

    it('refuses an api key scheme with an empty name', () => {
      const nameless: OpenAPIV3.ApiKeySecurityScheme = {
        type: 'apiKey',
        name: '',
        in: 'header',
      };

      expect(buildAuthHeaders(credential, nameless)).toBeUndefined();
    });

    it('returns undefined without a scheme to name the header', () => {
      expect(buildAuthHeaders(credential)).toBeUndefined();
    });
  });
});
