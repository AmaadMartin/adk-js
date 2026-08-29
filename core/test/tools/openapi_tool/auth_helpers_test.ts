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
  parseAuthScheme,
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

  describe('parseAuthScheme', () => {
    const apiKeyScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const httpScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'http',
      scheme: 'bearer',
    };
    const oauth2Scheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    };
    const openIdScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://example.com/.well-known/openid-configuration',
    };

    it.each([
      ['apiKey', apiKeyScheme],
      ['http', httpScheme],
      ['oauth2', oauth2Scheme],
      ['openIdConnect', openIdScheme],
    ])('should accept a valid %s scheme', (_type, scheme) => {
      expect(parseAuthScheme(scheme)).toBe(scheme);
      expect(parseAuthScheme(JSON.stringify(scheme))).toEqual(scheme);
    });

    it('should reject a scheme with no type', () => {
      expect(() => parseAuthScheme('{"name": "X-API-Key"}')).toThrow(
        "Missing 'type' field in security scheme.",
      );
    });

    it('should reject a scheme that is not an object', () => {
      expect(() => parseAuthScheme('null')).toThrow(
        "Missing 'type' field in security scheme.",
      );
    });

    it('should reject an unsupported type', () => {
      expect(() => parseAuthScheme('{"type": "basic"}')).toThrow(
        'Invalid security scheme type: basic',
      );
    });

    it.each([
      ['{"type": "apiKey", "in": "header"}', "'name' must be a string"],
      ['{"type": "apiKey", "name": "X-API-Key"}', "'in' must be a string"],
      ['{"type": "http"}', "'scheme' must be a string"],
      ['{"type": "oauth2"}', "'flows' must be an object"],
      ['{"type": "oauth2", "flows": []}', "'flows' must be an object"],
      ['{"type": "openIdConnect"}', "'openIdConnectUrl' must be a string"],
    ])('should reject %s', (json, message) => {
      expect(() => parseAuthScheme(json)).toThrow(
        `Invalid security scheme data: ${message}.`,
      );
    });

    it('should surface a JSON syntax error', () => {
      expect(() => parseAuthScheme('{not json')).toThrow(SyntaxError);
    });
  });
});
