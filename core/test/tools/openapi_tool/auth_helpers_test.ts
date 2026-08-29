/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {dictToAuthScheme} from '@google/adk';
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

  describe('dictToAuthScheme', () => {
    it('should accept an apiKey scheme', () => {
      const data = {type: 'apiKey', name: 'X-API-Key', in: 'header'};
      expect(dictToAuthScheme(data)).toEqual(data);
    });

    it('should accept an http basic scheme', () => {
      const data = {type: 'http', scheme: 'basic'};
      expect(dictToAuthScheme(data)).toEqual(data);
    });

    it('should accept an http bearer scheme', () => {
      const data = {type: 'http', scheme: 'bearer', bearerFormat: 'JWT'};
      expect(dictToAuthScheme(data)).toEqual(data);
    });

    it('should accept an oauth2 scheme', () => {
      const data = {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/auth',
            tokenUrl: 'https://example.com/token',
            scopes: {},
          },
        },
      };
      expect(dictToAuthScheme(data)).toEqual(data);
    });

    it('should accept an openIdConnect scheme', () => {
      const data = {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
      };
      expect(dictToAuthScheme(data)).toEqual(data);
    });

    it('should reject a scheme that names no type', () => {
      expect(() => dictToAuthScheme({in: 'header'})).toThrow(
        "Missing 'type' field in security scheme dictionary.",
      );
    });

    it('should reject a value that is not an object', () => {
      expect(() => dictToAuthScheme('apiKey')).toThrow(
        "Missing 'type' field in security scheme dictionary.",
      );
    });

    it('should reject an unknown type', () => {
      expect(() => dictToAuthScheme({type: 'nope'})).toThrow(
        'Invalid security scheme type: nope',
      );
    });

    it('should reject an apiKey scheme with no name', () => {
      expect(() => dictToAuthScheme({type: 'apiKey', in: 'header'})).toThrow(
        "Invalid security scheme data: 'name' must be a string.",
      );
    });

    it('should reject an apiKey scheme with an unsupported location', () => {
      expect(() =>
        dictToAuthScheme({type: 'apiKey', name: 'X-API-Key', in: 'body'}),
      ).toThrow(
        "Invalid security scheme data: 'in' must be one of query, header, cookie.",
      );
    });

    it('should reject an http scheme with no scheme', () => {
      expect(() => dictToAuthScheme({type: 'http'})).toThrow(
        "Invalid security scheme data: 'scheme' must be a string.",
      );
    });

    it('should reject an oauth2 scheme with no flows', () => {
      expect(() => dictToAuthScheme({type: 'oauth2'})).toThrow(
        "Invalid security scheme data: 'flows' must be an object.",
      );
    });

    it('should reject an openIdConnect scheme with no url', () => {
      expect(() => dictToAuthScheme({type: 'openIdConnect'})).toThrow(
        "Invalid security scheme data: 'openIdConnectUrl' must be a string.",
      );
    });
  });
});
