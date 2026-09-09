/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  HttpAuth,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {buildAuthHeaders} from '../../src/auth/auth_headers.js';
import {logger} from '../../src/utils/logger.js';

const API_KEY_HEADER_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

/** Captures the warnings a call emits without printing them. */
function spyOnWarn() {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

describe('buildAuthHeaders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined without a credential', () => {
    expect(buildAuthHeaders()).toBeUndefined();
  });

  it('returns undefined for a credential that carries nothing sendable', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  describe('oauth2', () => {
    it('sends the access token as a bearer token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'test-access-token'},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer test-access-token',
      });
    });

    it('sends nothing when the credential has no access token yet', () => {
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
        http: {scheme: 'bearer', credentials: {token: 'test-bearer-token'}},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer test-bearer-token',
      });
    });

    it('matches the scheme case-insensitively', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Bearer', credentials: {token: 'test-bearer-token'}},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer test-bearer-token',
      });
    });

    it('base64-encodes a username and password as basic auth', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'basic',
          credentials: {username: 'testuser', password: 'testpass'},
        },
      };

      const encoded = Buffer.from('testuser:testpass', 'utf8').toString(
        'base64',
      );
      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: `Basic ${encoded}`,
      });
    });

    it('sends nothing for basic auth with a username but no password', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'testuser'}},
      };

      expect(buildAuthHeaders(credential)).toBeUndefined();
    });

    it('sends the token under any other scheme name', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Negotiate', credentials: {token: 'test-token'}},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Negotiate test-token',
      });
    });

    it('sends nothing for a bearer scheme with no token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {}},
      };

      expect(buildAuthHeaders(credential)).toBeUndefined();
    });

    it('sends nothing when the credential carries no credentials object', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        // `HttpAuth` makes `credentials` mandatory, but a document can omit it.
        http: {scheme: 'bearer'} as HttpAuth,
      };

      expect(buildAuthHeaders(credential)).toBeUndefined();
    });

    it('merges additional headers over the scheme header', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'test-bearer-token'},
          additionalHeaders: {'X-Tenant': 'acme'},
        },
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer test-bearer-token',
        'X-Tenant': 'acme',
      });
    });

    it('sends additional headers even when no scheme header was built', () => {
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
    it('sends the key in the header the scheme names', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test-api-key-12345',
      };

      expect(buildAuthHeaders(credential, API_KEY_HEADER_SCHEME)).toEqual({
        'X-API-Key': 'test-api-key-12345',
      });
    });

    it('warns and sends nothing for a query-located key', () => {
      const warn = spyOnWarn();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test-api-key',
      };

      const headers = buildAuthHeaders(credential, {
        type: 'apiKey',
        in: 'query',
        name: 'api_key',
      });

      expect(headers).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Only header-based API key authentication'),
      );
    });

    it('sends the key in the named header when the scheme omits its location', () => {
      const warn = spyOnWarn();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test-api-key',
      };
      // `openapi-types` makes `in` mandatory, but a document can omit it.
      const schemeWithoutLocation = {
        type: 'apiKey',
        name: 'X-API-Key',
      } as unknown as AuthScheme;

      expect(buildAuthHeaders(credential, schemeWithoutLocation)).toEqual({
        'X-API-Key': 'test-api-key',
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns and sends nothing without an apiKey scheme to name the header', () => {
      const warn = spyOnWarn();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test-api-key',
      };

      expect(buildAuthHeaders(credential)).toBeUndefined();
      expect(
        buildAuthHeaders(credential, {type: 'http', scheme: 'bearer'}),
      ).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
