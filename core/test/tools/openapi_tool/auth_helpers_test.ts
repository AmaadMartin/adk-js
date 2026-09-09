/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {
  applyCredential,
  createApiKeyScheme,
  createBearerScheme,
} from '../../../src/tools/openapi_tool/auth/auth_helpers.js';

describe('auth_helpers', () => {
  describe('applyCredential', () => {
    it('should return original URL if credential is not provided', () => {
      const url = 'http://example.com';
      const headers = {};
      const result = applyCredential(url, headers, undefined);
      expect(result).toBe(url);
      expect(headers).toEqual({});
    });

    it('should apply API key in header', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };
      const authScheme: OpenAPIV3.SecuritySchemeObject = {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      };

      const result = applyCredential(url, headers, credential, authScheme);

      expect(result).toBe(url);
      expect(headers['X-API-Key']).toBe('secret_key');
    });

    it('should apply API key in query', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };
      const authScheme: OpenAPIV3.SecuritySchemeObject = {
        type: 'apiKey',
        name: 'api_key',
        in: 'query',
      };

      const result = applyCredential(url, headers, credential, authScheme);

      expect(result).toBe('http://example.com?api_key=secret_key');
      expect(headers).toEqual({});
    });

    it('should apply API key in query with existing params', () => {
      const url = 'http://example.com?foo=bar';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };
      const authScheme: OpenAPIV3.SecuritySchemeObject = {
        type: 'apiKey',
        name: 'api_key',
        in: 'query',
      };

      const result = applyCredential(url, headers, credential, authScheme);

      expect(result).toBe('http://example.com?foo=bar&api_key=secret_key');
    });

    it('should apply API key in cookie', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };
      const authScheme: OpenAPIV3.SecuritySchemeObject = {
        type: 'apiKey',
        name: 'session_id',
        in: 'cookie',
      };

      const result = applyCredential(url, headers, credential, authScheme);

      expect(result).toBe(url);
      expect(headers).toEqual({Cookie: 'session_id=secret_key'});
    });

    it('should append API key to an existing Cookie header', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {Cookie: 'theme=dark'};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };
      const authScheme: OpenAPIV3.SecuritySchemeObject = {
        type: 'apiKey',
        name: 'session_id',
        in: 'cookie',
      };

      applyCredential(url, headers, credential, authScheme);

      expect(headers['Cookie']).toBe('theme=dark; session_id=secret_key');
    });

    it('should append to an existing lowercase cookie header', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {cookie: 'theme=dark'};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };
      const authScheme: OpenAPIV3.SecuritySchemeObject = {
        type: 'apiKey',
        name: 'session_id',
        in: 'cookie',
      };

      applyCredential(url, headers, credential, authScheme);

      expect(headers['cookie']).toBe('theme=dark; session_id=secret_key');
      expect(headers['Cookie']).toBeUndefined();
    });

    it('should percent-encode the cookie value', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'a b;c',
      };
      const authScheme: OpenAPIV3.SecuritySchemeObject = {
        type: 'apiKey',
        name: 'session_id',
        in: 'cookie',
      };

      applyCredential(url, headers, credential, authScheme);

      expect(headers['Cookie']).toBe('session_id=a%20b%3Bc');
    });

    it('should apply API key in cookie for a scheme built by createApiKeyScheme', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };

      const result = applyCredential(
        url,
        headers,
        credential,
        createApiKeyScheme('session_id', 'cookie'),
      );

      expect(result).toBe(url);
      expect(headers).toEqual({Cookie: 'session_id=secret_key'});
    });

    it('should throw for an unrecognised API key location', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };
      const authScheme: OpenAPIV3.SecuritySchemeObject = {
        type: 'apiKey',
        name: 'session_id',
        in: 'cookies',
      };

      expect(() =>
        applyCredential(url, headers, credential, authScheme),
      ).toThrow('Invalid API Key location: cookies');
      expect(headers).toEqual({});
    });

    it('should fallback to Authorization header for API key if location is not specified', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      };

      const result = applyCredential(url, headers, credential);

      expect(result).toBe(url);
      expect(headers['Authorization']).toBe('secret_key');
    });

    it('should apply bearer token', () => {
      const url = 'http://example.com';
      const headers: Record<string, string> = {};
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {
            token: 'my_token',
          },
        },
      };

      const result = applyCredential(url, headers, credential);

      expect(result).toBe(url);
      expect(headers['Authorization']).toBe('Bearer my_token');
    });
  });

  describe('createApiKeyScheme', () => {
    it('should create an API key scheme', () => {
      const result = createApiKeyScheme('X-API-Key', 'header');
      expect(result).toEqual({
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      });
    });
  });

  describe('createBearerScheme', () => {
    it('should create a bearer scheme', () => {
      const result = createBearerScheme();
      expect(result).toEqual({
        type: 'http',
        scheme: 'bearer',
      });
    });
  });
});
