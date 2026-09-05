/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Logger,
  getLogger,
  setLogger,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

// `auth_headers` is internal to the MCP tools, so it is not re-exported from
// the package barrel and the test reaches it by relative path.
import {credentialToHeaders} from '../../../src/tools/mcp/auth_headers.js';

const API_KEY = 'super-secret-key';

/** An API-key scheme placing the key in the named location. */
function apiKeyScheme(location: 'header' | 'query' | 'cookie'): AuthScheme {
  return {type: 'apiKey', in: location, name: 'X-Api-Key'};
}

/** Collects ADK warnings for the rest of the test. */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  const noop = () => {};
  const capturingLogger: Logger = {
    setLogLevel: noop,
    log: noop,
    debug: noop,
    info: noop,
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: noop,
  };
  setLogger(capturingLogger);
  return warnings;
}

describe('credentialToHeaders', () => {
  const originalLogger = getLogger();

  afterEach(() => {
    setLogger(originalLogger);
  });

  it('returns undefined when there is no credential', () => {
    expect(credentialToHeaders(undefined, undefined)).toBeUndefined();
  });

  describe('oauth2', () => {
    it('carries the access token as a bearer header', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'oauth-token'},
      };

      expect(credentialToHeaders(credential, undefined)).toEqual({
        Authorization: 'Bearer oauth-token',
      });
    });

    it('contributes no header when the token is missing', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'a-client'},
      };

      expect(credentialToHeaders(credential, undefined)).toBeUndefined();
    });
  });

  describe('http', () => {
    it('carries a bearer token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Bearer', credentials: {token: 'http-token'}},
      };

      expect(credentialToHeaders(credential, undefined)).toEqual({
        Authorization: 'Bearer http-token',
      });
    });

    it('contributes no header when a bearer scheme has no token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {}},
      };

      expect(credentialToHeaders(credential, undefined)).toBeUndefined();
    });

    it('encodes a basic username and password', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'basic',
          credentials: {username: 'user', password: 'pass'},
        },
      };

      // Computed independently of the implementation.
      const expected = Buffer.from('user:pass').toString('base64');
      expect(credentialToHeaders(credential, undefined)).toEqual({
        Authorization: `Basic ${expected}`,
      });
    });

    it('contributes no header when basic auth is missing the password', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'user'}},
      };

      expect(credentialToHeaders(credential, undefined)).toBeUndefined();
    });

    it('keeps the declared case of a custom scheme', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Custom', credentials: {token: 'custom-token'}},
      };

      expect(credentialToHeaders(credential, undefined)).toEqual({
        Authorization: 'Custom custom-token',
      });
    });

    it('contributes no header when a custom scheme has no token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Custom', credentials: {}},
      };

      expect(credentialToHeaders(credential, undefined)).toBeUndefined();
    });

    it('merges additional headers alongside the token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'http-token'},
          additionalHeaders: {'X-Extra': 'extra-value'},
        },
      };

      expect(credentialToHeaders(credential, undefined)).toEqual({
        Authorization: 'Bearer http-token',
        'X-Extra': 'extra-value',
      });
    });

    it('carries additional headers when there is no token', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {},
          additionalHeaders: {'X-Extra': 'extra-value'},
        },
      };

      expect(credentialToHeaders(credential, undefined)).toEqual({
        'X-Extra': 'extra-value',
      });
    });
  });

  describe('apiKey', () => {
    it('puts the key in the header the scheme names', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: API_KEY,
      };

      expect(credentialToHeaders(credential, apiKeyScheme('header'))).toEqual({
        'X-Api-Key': API_KEY,
      });
    });

    it('rejects a query-located key', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: API_KEY,
      };

      expect(() =>
        credentialToHeaders(credential, apiKeyScheme('query')),
      ).toThrow('only supports header-based API key authentication');
    });

    it('names the unsupported location it was given', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: API_KEY,
      };

      expect(() =>
        credentialToHeaders(credential, apiKeyScheme('cookie')),
      ).toThrow('cookie');
    });

    it('rejects a key with no scheme to name its header', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: API_KEY,
      };

      expect(() => credentialToHeaders(credential, undefined)).toThrow(
        'Cannot find corresponding auth scheme for API key credential.',
      );
    });

    it('rejects a key whose scheme is not an API-key scheme', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: API_KEY,
      };
      const httpScheme: AuthScheme = {type: 'http', scheme: 'bearer'};

      expect(() => credentialToHeaders(credential, httpScheme)).toThrow(
        'Cannot find corresponding auth scheme for API key credential.',
      );
    });

    it('never repeats the key in the error it raises', () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: API_KEY,
      };

      for (const scheme of [undefined, apiKeyScheme('query')]) {
        let raised: unknown;
        try {
          credentialToHeaders(credential, scheme);
        } catch (e: unknown) {
          raised = e;
        }
        expect(raised).toBeInstanceOf(Error);
        expect((raised as Error).message).not.toContain(API_KEY);
      }
    });
  });

  describe('serviceAccount', () => {
    it('contributes no header and warns that it must be exchanged', () => {
      const warnings = captureWarnings();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      };

      expect(credentialToHeaders(credential, undefined)).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('exchanged');
    });
  });
});
