/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  buildAuthHeaders,
  getLogger,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const API_KEY_HEADER_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
};

describe('buildAuthHeaders', () => {
  it('returns undefined without a credential', () => {
    expect(buildAuthHeaders()).toBeUndefined();
  });

  it('returns undefined for a credential carrying nothing usable', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  describe('oauth2', () => {
    it('sends the access token as a bearer token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'tok'},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer tok',
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
        http: {scheme: 'bearer', credentials: {token: 'tok'}},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer tok',
      });
    });

    it('base64-encodes basic credentials', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'basic',
          credentials: {username: 'user', password: 'pass'},
        },
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`,
      });
    });

    it('returns undefined for basic auth missing a password', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'user'}},
      };

      expect(buildAuthHeaders(credential)).toBeUndefined();
    });

    it('keeps the declared casing of another http scheme', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Digest', credentials: {token: 'tok'}},
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Digest tok',
      });
    });

    it('merges additionalHeaders over the built header', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'tok'},
          additionalHeaders: {'X-Trace': '1'},
        },
      };

      expect(buildAuthHeaders(credential)).toEqual({
        Authorization: 'Bearer tok',
        'X-Trace': '1',
      });
    });

    it('returns additionalHeaders alone when there is no token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {},
          additionalHeaders: {'X-Trace': '1'},
        },
      };

      expect(buildAuthHeaders(credential)).toEqual({'X-Trace': '1'});
    });
  });

  describe('apiKey', () => {
    it('names the header after the scheme', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      };

      expect(buildAuthHeaders(credential, API_KEY_HEADER_SCHEME)).toEqual({
        'X-Api-Key': 'key',
      });
    });

    it('warns and adds nothing for a non-header key location', () => {
      const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      };
      const scheme: AuthScheme = {type: 'apiKey', in: 'query', name: 'key'};

      expect(buildAuthHeaders(credential, scheme)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Only header-based API key authentication'),
      );
      warn.mockRestore();
    });

    it('adds nothing when the scheme does not name a header', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      };
      const scheme: AuthScheme = {type: 'http', scheme: 'bearer'};

      expect(buildAuthHeaders(credential, scheme)).toBeUndefined();
      expect(buildAuthHeaders(credential)).toBeUndefined();
    });
  });
});
