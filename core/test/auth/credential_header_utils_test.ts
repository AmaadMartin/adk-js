/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes, AuthScheme} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
// The helper and the logger singleton are both internal, so they are imported
// via relative paths rather than through the public entry point.
import {authCredentialToHeaders} from '../../src/auth/credential_header_utils.js';
import {logger} from '../../src/utils/logger.js';

/**
 * The `test_get_headers_*` cases below are ported from adk-python,
 * `tests/unittests/tools/mcp_tool/test_mcp_tool.py`, and keep their original
 * names so the two suites can be compared. The API key case follows
 * adk-python `main`, which reads the header name from the auth scheme rather
 * than hardcoding `X-API-Key`.
 */

const API_KEY_HEADER_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-Custom-Key',
  in: 'header',
};

describe('authCredentialToHeaders', () => {
  describe('ported from adk-python test_mcp_tool.py', () => {
    it('test_get_headers_oauth2', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'test_token'},
      });

      expect(headers).toEqual({Authorization: 'Bearer test_token'});
    });

    it('test_get_headers_http_bearer', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'test_token'}},
      });

      expect(headers).toEqual({Authorization: 'Bearer test_token'});
    });

    it('test_get_headers_http_basic', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'basic',
          credentials: {username: 'user', password: 'pass'},
        },
      });

      const encoded = Buffer.from('user:pass').toString('base64');
      expect(headers).toEqual({Authorization: `Basic ${encoded}`});
    });

    it('test_get_headers_http_custom_scheme', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Custom', credentials: {token: 'test_token'}},
      });

      expect(headers).toEqual({Authorization: 'Custom test_token'});
    });

    it('test_get_headers_api_key', () => {
      const headers = authCredentialToHeaders(
        {authType: AuthCredentialTypes.API_KEY, apiKey: 'test_api_key'},
        API_KEY_HEADER_SCHEME,
      );

      expect(headers).toEqual({'X-Custom-Key': 'test_api_key'});
    });

    it('test_get_headers_no_credential', () => {
      expect(authCredentialToHeaders(undefined)).toBeUndefined();
    });

    it('test_get_headers_service_account_no_json', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      });

      expect(headers).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('service account credential'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('additional headers', () => {
    it('merges additionalHeaders on top of a bearer header', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'test_token'},
          additionalHeaders: {'X-Tenant': 'acme'},
        },
      });

      expect(headers).toEqual({
        Authorization: 'Bearer test_token',
        'X-Tenant': 'acme',
      });
    });

    it('lets additionalHeaders override the Authorization header', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'test_token'},
          additionalHeaders: {Authorization: 'Bearer override'},
        },
      });

      expect(headers).toEqual({Authorization: 'Bearer override'});
    });

    it('returns additionalHeaders when no scheme produced a header', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {},
          additionalHeaders: {'X-Tenant': 'acme'},
        },
      });

      expect(headers).toEqual({'X-Tenant': 'acme'});
    });
  });

  describe('credentials that carry nothing sendable', () => {
    it('returns undefined for basic auth missing a password', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'user'}},
      });

      expect(headers).toBeUndefined();
    });

    it('returns undefined for basic auth missing a username', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {password: 'pass'}},
      });

      expect(headers).toBeUndefined();
    });

    it('returns undefined for a bearer scheme with no token', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {}},
      });

      expect(headers).toBeUndefined();
    });

    it('returns undefined for a custom scheme with no token', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Custom', credentials: {}},
      });

      expect(headers).toBeUndefined();
    });

    it('returns undefined for a credential with no populated kind', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.API_KEY,
      });

      expect(headers).toBeUndefined();
    });
  });

  describe('api key scheme validation', () => {
    it('throws when the api key scheme is not in the header', () => {
      expect(() =>
        authCredentialToHeaders(
          {authType: AuthCredentialTypes.API_KEY, apiKey: 'test_api_key'},
          {type: 'apiKey', name: 'api_key', in: 'query'},
        ),
      ).toThrow(/located in the header; got: query/);
    });

    it('throws when no auth scheme is configured', () => {
      expect(() =>
        authCredentialToHeaders({
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'test_api_key',
        }),
      ).toThrow(/requires an apiKey auth scheme; none is configured/);
    });

    it('throws when the auth scheme is not an apiKey scheme', () => {
      expect(() =>
        authCredentialToHeaders(
          {authType: AuthCredentialTypes.API_KEY, apiKey: 'test_api_key'},
          {type: 'http', scheme: 'bearer'},
        ),
      ).toThrow(/requires an apiKey auth scheme; none is configured/);
    });
  });

  describe('precedence between credential kinds', () => {
    it('prefers oauth2 over http', () => {
      const headers = authCredentialToHeaders({
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'oauth_token'},
        http: {scheme: 'bearer', credentials: {token: 'http_token'}},
      });

      expect(headers).toEqual({Authorization: 'Bearer oauth_token'});
    });

    it('prefers http over an api key', () => {
      const headers = authCredentialToHeaders(
        {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'http_token'}},
          apiKey: 'test_api_key',
        },
        API_KEY_HEADER_SCHEME,
      );

      expect(headers).toEqual({Authorization: 'Bearer http_token'});
    });

    it('prefers an api key over a service account', () => {
      const headers = authCredentialToHeaders(
        {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'test_api_key',
          serviceAccount: {useDefaultCredential: true},
        },
        API_KEY_HEADER_SCHEME,
      );

      expect(headers).toEqual({'X-Custom-Key': 'test_api_key'});
    });
  });
});
