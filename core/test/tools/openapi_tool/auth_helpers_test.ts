/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiKeyLocation,
  AuthScheme,
  INTERNAL_AUTH_PREFIX,
  ServiceAccount,
  TokenType,
  credentialToParam,
  dictToAuthScheme,
  openidDictToSchemeCredential,
  openidUrlToSchemeCredential,
  serviceAccountDictToSchemeCredential,
  serviceAccountSchemeCredential,
  tokenToSchemeCredential,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {
  applyCredential,
  createApiKeyScheme,
  createBearerScheme,
} from '../../../src/tools/openapi_tool/auth/auth_helpers.js';

const BEARER_JWT_SCHEME = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
};

/** A Google service account key file, with the casing it ships with. */
const SERVICE_ACCOUNT_KEY: Record<string, unknown> = {
  type: 'service_account',
  project_id: 'project_id',
  private_key_id: 'private_key_id',
  private_key: 'private_key',
  client_email: 'client_email',
  client_id: 'client_id',
  auth_uri: 'auth_uri',
  token_uri: 'token_uri',
  auth_provider_x509_cert_url: 'auth_provider_x509_cert_url',
  client_x509_cert_url: 'client_x509_cert_url',
  universe_domain: 'universe_domain',
};

const OPENID_CONFIG: Record<string, unknown> = {
  authorization_endpoint: 'auth_url',
  token_endpoint: 'token_url',
  openIdConnectUrl: 'openid_url',
};

const OAUTH_CLIENT: Record<string, unknown> = {
  client_id: 'client_id',
  client_secret: 'client_secret',
  redirect_uri: 'redirect_uri',
};

const BEARER_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'test_token'}},
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

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

  describe('tokenToSchemeCredential', () => {
    it('builds an apiKey scheme for a header', () => {
      const {authScheme, authCredential} = tokenToSchemeCredential(
        'apikey',
        'header',
        'X-API-Key',
        'test_key',
      );

      expect(authScheme).toEqual({
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      });
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test_key',
      });
    });

    it('builds an apiKey scheme for a query parameter', () => {
      const {authScheme, authCredential} = tokenToSchemeCredential(
        'apikey',
        'query',
        'api_key',
        'test_key',
      );

      expect(authScheme).toEqual({
        type: 'apiKey',
        in: 'query',
        name: 'api_key',
      });
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test_key',
      });
    });

    it('builds an apiKey scheme for a cookie', () => {
      const {authScheme, authCredential} = tokenToSchemeCredential(
        'apikey',
        'cookie',
        'session_id',
        'test_key',
      );

      expect(authScheme).toEqual({
        type: 'apiKey',
        in: 'cookie',
        name: 'session_id',
      });
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test_key',
      });
    });

    it('omits the credential when no API key value is given', () => {
      const {authScheme, authCredential} = tokenToSchemeCredential(
        'apikey',
        'cookie',
        'session_id',
      );

      expect(authScheme).toEqual({
        type: 'apiKey',
        in: 'cookie',
        name: 'session_id',
      });
      expect(authCredential).toBeUndefined();
    });

    it('builds a bearer scheme and credential for an oauth2 token', () => {
      const {authScheme, authCredential} = tokenToSchemeCredential(
        'oauth2Token',
        'header',
        'Authorization',
        'test_token',
      );

      expect(authScheme).toEqual(BEARER_JWT_SCHEME);
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'test_token'}},
      });
    });

    it('omits the credential when no oauth2 token is given', () => {
      const {authScheme, authCredential} = tokenToSchemeCredential(
        'oauth2Token',
        'header',
        'Authorization',
      );

      expect(authScheme).toEqual(BEARER_JWT_SCHEME);
      expect(authCredential).toBeUndefined();
    });

    it('names an apiKey scheme with an empty string when no name is given', () => {
      const {authScheme} = tokenToSchemeCredential('apikey', 'header');

      expect(authScheme).toEqual({type: 'apiKey', in: 'header', name: ''});
    });

    it('rejects a missing apiKey location', () => {
      expect(() => tokenToSchemeCredential('apikey', undefined, 'k')).toThrow(
        'Invalid location for apiKey: undefined',
      );
    });

    it('rejects an apiKey location outside header, query and cookie', () => {
      // The location is validated for callers that reach this from plain
      // JavaScript, where the union does not apply.
      const location = 'body' as ApiKeyLocation;

      expect(() => tokenToSchemeCredential('apikey', location, 'k')).toThrow(
        'Invalid location for apiKey: body',
      );
    });

    it('rejects an unknown token type', () => {
      // The token type is validated for the same reason as the location.
      const tokenType = 'bogus' as TokenType;

      expect(() => tokenToSchemeCredential(tokenType)).toThrow(
        'Invalid security scheme type: bogus',
      );
    });
  });

  describe('serviceAccountDictToSchemeCredential', () => {
    it('reads a snake_case service account key file', () => {
      const scopes = ['scope1', 'scope2'];

      const {authScheme, authCredential} = serviceAccountDictToSchemeCredential(
        SERVICE_ACCOUNT_KEY,
        scopes,
      );

      expect(authScheme).toEqual(BEARER_JWT_SCHEME);
      expect(authCredential?.authType).toBe(
        AuthCredentialTypes.SERVICE_ACCOUNT,
      );
      expect(authCredential?.serviceAccount?.scopes).toEqual(scopes);
      expect(
        authCredential?.serviceAccount?.serviceAccountCredential?.projectId,
      ).toBe('project_id');
      expect(
        authCredential?.serviceAccount?.serviceAccountCredential
          ?.authProviderX509CertUrl,
      ).toBe('auth_provider_x509_cert_url');
    });

    it('defaults the universe domain when the key file omits it', () => {
      const {universe_domain: _omitted, ...key} = SERVICE_ACCOUNT_KEY;

      const {authCredential} = serviceAccountDictToSchemeCredential(key, []);

      expect(
        authCredential?.serviceAccount?.serviceAccountCredential
          ?.universeDomain,
      ).toBe('googleapis.com');
    });

    it('rejects a key file that is missing the private key', () => {
      const {private_key: _omitted, ...key} = SERVICE_ACCOUNT_KEY;

      expect(() => serviceAccountDictToSchemeCredential(key, [])).toThrow(
        'Invalid service account configuration: privateKey',
      );
    });
  });

  describe('serviceAccountSchemeCredential', () => {
    it('wraps a service account without copying it', () => {
      const config: ServiceAccount = {
        serviceAccountCredential: {
          type: 'service_account',
          projectId: 'project_id',
          privateKeyId: 'private_key_id',
          privateKey: 'private_key',
          clientEmail: 'client_email',
          clientId: 'client_id',
          authUri: 'auth_uri',
          tokenUri: 'token_uri',
          authProviderX509CertUrl: 'auth_provider_x509_cert_url',
          clientX509CertUrl: 'client_x509_cert_url',
          universeDomain: 'universe_domain',
        },
        scopes: ['scope1', 'scope2'],
      };

      const {authScheme, authCredential} =
        serviceAccountSchemeCredential(config);

      expect(authScheme).toEqual(BEARER_JWT_SCHEME);
      expect(authCredential?.authType).toBe(
        AuthCredentialTypes.SERVICE_ACCOUNT,
      );
      expect(authCredential?.serviceAccount).toBe(config);
    });
  });

  describe('openidDictToSchemeCredential', () => {
    it('builds the scheme and the credential from a static config', () => {
      const scopes = ['scope1', 'scope2'];

      const {authScheme, authCredential} = openidDictToSchemeCredential(
        OPENID_CONFIG,
        scopes,
        OAUTH_CLIENT,
      );

      expect(authScheme.type).toBe('openIdConnect');
      expect(authScheme.authorizationEndpoint).toBe('auth_url');
      expect(authScheme.tokenEndpoint).toBe('token_url');
      expect(authScheme.openIdConnectUrl).toBe('openid_url');
      expect(authScheme.scopes).toEqual(scopes);
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {
          clientId: 'client_id',
          clientSecret: 'client_secret',
          redirectUri: 'redirect_uri',
        },
      });
    });

    it('keeps the extra keys of a discovery document', () => {
      const {authScheme} = openidDictToSchemeCredential(
        {...OPENID_CONFIG, userinfo_endpoint: 'userinfo_url'},
        [],
        OAUTH_CLIENT,
      );

      expect(authScheme.userinfoEndpoint).toBe('userinfo_url');
    });

    it('defaults the connect URL to an empty string', () => {
      const {openIdConnectUrl: _omitted, ...config} = OPENID_CONFIG;

      const {authScheme} = openidDictToSchemeCredential(
        config,
        [],
        OAUTH_CLIENT,
      );

      expect(authScheme.openIdConnectUrl).toBe('');
    });

    it('unwraps a client secret file downloaded from Google', () => {
      const {authCredential} = openidDictToSchemeCredential(OPENID_CONFIG, [], {
        web: OAUTH_CLIENT,
      });

      expect(authCredential.oauth2).toEqual({
        clientId: 'client_id',
        clientSecret: 'client_secret',
        redirectUri: 'redirect_uri',
      });
    });

    it('keeps a single-key credential that is not an OAuth client', () => {
      expect(() =>
        openidDictToSchemeCredential(OPENID_CONFIG, [], {
          web: {client_id: 'client_id'},
        }),
      ).toThrow(
        'Missing required fields in credential_dict: client_id, client_secret',
      );
    });

    it('rejects a config without the required endpoints', () => {
      expect(() =>
        openidDictToSchemeCredential(
          {invalid_field: 'value'},
          [],
          OAUTH_CLIENT,
        ),
      ).toThrow('Invalid OpenID Connect configuration');
    });

    it('names the credential field that is missing', () => {
      expect(() =>
        openidDictToSchemeCredential(OPENID_CONFIG, [], {
          client_id: 'client_id',
        }),
      ).toThrow('Missing required fields in credential_dict: client_secret');
    });

    it('omits the redirect URI when the client has none', () => {
      const {authCredential} = openidDictToSchemeCredential(OPENID_CONFIG, [], {
        client_id: 'client_id',
        client_secret: 'client_secret',
      });

      expect(authCredential.oauth2?.redirectUri).toBeUndefined();
    });
  });

  describe('openidUrlToSchemeCredential', () => {
    const openidUrl = 'https://accounts.example.com/openid-configuration';

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('fetches the discovery document once and builds the pair', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          authorization_endpoint: 'auth_url',
          token_endpoint: 'token_url',
          userinfo_endpoint: 'userinfo_url',
        }),
      );
      const scopes = ['scope1', 'scope2'];

      const {authScheme, authCredential} = await openidUrlToSchemeCredential(
        openidUrl,
        scopes,
        OAUTH_CLIENT,
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(openidUrl, expect.anything());
      expect(authScheme.authorizationEndpoint).toBe('auth_url');
      expect(authScheme.tokenEndpoint).toBe('token_url');
      expect(authScheme.userinfoEndpoint).toBe('userinfo_url');
      expect(authScheme.scopes).toEqual(scopes);
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {
          clientId: 'client_id',
          clientSecret: 'client_secret',
          redirectUri: 'redirect_uri',
        },
      });
    });

    it('records the fetched URL on the scheme', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          authorization_endpoint: 'auth_url',
          token_endpoint: 'token_url',
        }),
      );

      const {authScheme} = await openidUrlToSchemeCredential(
        openidUrl,
        [],
        OAUTH_CLIENT,
      );

      expect(authScheme.openIdConnectUrl).toBe(openidUrl);
    });

    it('reports a failed request', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Test Error'));

      await expect(
        openidUrlToSchemeCredential(openidUrl, [], OAUTH_CLIENT),
      ).rejects.toThrow(
        `Failed to fetch OpenID configuration from ${openidUrl}: Test Error`,
      );
    });

    it('reports a rejection that is not an Error', async () => {
      vi.mocked(fetch).mockRejectedValue('socket closed');

      await expect(
        openidUrlToSchemeCredential(openidUrl, [], OAUTH_CLIENT),
      ).rejects.toThrow(
        `Failed to fetch OpenID configuration from ${openidUrl}: socket closed`,
      );
    });

    it('reports an error status', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('', {status: 404}));

      await expect(
        openidUrlToSchemeCredential(openidUrl, [], OAUTH_CLIENT),
      ).rejects.toThrow(
        `Failed to fetch OpenID configuration from ${openidUrl}: HTTP 404`,
      );
    });

    it('reports a body that is not JSON', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('not json'));

      await expect(
        openidUrlToSchemeCredential(openidUrl, [], OAUTH_CLIENT),
      ).rejects.toThrow(
        `Invalid JSON response from OpenID configuration endpoint ${openidUrl}`,
      );
    });

    it('reports a JSON body that is not an object', async () => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(['not', 'an', 'object']));

      await expect(
        openidUrlToSchemeCredential(openidUrl, [], OAUTH_CLIENT),
      ).rejects.toThrow(
        `Invalid JSON response from OpenID configuration endpoint ${openidUrl}`,
      );
    });

    it('propagates a credential error from the delegate', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({
          authorization_endpoint: 'auth_url',
          token_endpoint: 'token_url',
        }),
      );

      await expect(
        openidUrlToSchemeCredential(openidUrl, [], {}),
      ).rejects.toThrow(
        'Missing required fields in credential_dict: client_id, client_secret',
      );
    });
  });

  describe('credentialToParam', () => {
    const apiKeyCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    };

    it('sends an API key in a header', () => {
      const authScheme: AuthScheme = {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      };

      const result = credentialToParam(authScheme, apiKeyCredential);

      expect(result?.param).toEqual({
        originalName: 'X-API-Key',
        paramLocation: 'header',
        paramSchema: {type: 'string'},
        description: '',
        name: `${INTERNAL_AUTH_PREFIX}X-API-Key`,
        required: false,
      });
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}X-API-Key`]: 'test_key',
      });
    });

    it('sends an API key in a query parameter', () => {
      const authScheme: AuthScheme = {
        type: 'apiKey',
        in: 'query',
        name: 'api_key',
      };

      const result = credentialToParam(authScheme, apiKeyCredential);

      expect(result?.param.originalName).toBe('api_key');
      expect(result?.param.paramLocation).toBe('query');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}api_key`]: 'test_key',
      });
    });

    it('sends an API key in a cookie', () => {
      const authScheme: AuthScheme = {
        type: 'apiKey',
        in: 'cookie',
        name: 'session_id',
      };

      const result = credentialToParam(authScheme, apiKeyCredential);

      expect(result?.param.originalName).toBe('session_id');
      expect(result?.param.paramLocation).toBe('cookie');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}session_id`]: 'test_key',
      });
    });

    it('keeps the description of an apiKey scheme', () => {
      const authScheme: AuthScheme = {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'The tenant key.',
      };

      const result = credentialToParam(authScheme, apiKeyCredential);

      expect(result?.param.description).toBe('The tenant key.');
    });

    it('rejects an API key location the request cannot carry', () => {
      const authScheme: AuthScheme = {
        type: 'apiKey',
        in: 'body',
        name: 'X-API-Key',
      };

      expect(() => credentialToParam(authScheme, apiKeyCredential)).toThrow(
        'Invalid API Key location: body',
      );
    });

    it('sends an HTTP bearer token in the Authorization header', () => {
      const authScheme: AuthScheme = {type: 'http', scheme: 'bearer'};

      const result = credentialToParam(authScheme, BEARER_CREDENTIAL);

      expect(result?.param).toEqual({
        originalName: 'Authorization',
        paramLocation: 'header',
        paramSchema: {type: 'string'},
        description: 'Bearer token',
        name: `${INTERNAL_AUTH_PREFIX}Authorization`,
        required: false,
      });
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
      });
    });

    it('keeps the description of a bearer scheme', () => {
      const authScheme: AuthScheme = {
        type: 'http',
        scheme: 'bearer',
        description: 'The service token.',
      };

      const result = credentialToParam(authScheme, BEARER_CREDENTIAL);

      expect(result?.param.description).toBe('The service token.');
    });

    it('refuses basic authentication with a user name', () => {
      const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'user'}},
      };

      expect(() => credentialToParam(authScheme, authCredential)).toThrow(
        'Basic Authentication is not supported.',
      );
    });

    it('refuses basic authentication with a password', () => {
      const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {password: 'password'}},
      };

      expect(() => credentialToParam(authScheme, authCredential)).toThrow(
        'Basic Authentication is not supported.',
      );
    });

    it('rejects an HTTP credential that carries nothing', () => {
      const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
      };

      expect(() => credentialToParam(authScheme, authCredential)).toThrow(
        'Invalid HTTP auth credentials',
      );
    });

    it('sends the bearer token of an oauth2 scheme', () => {
      const authScheme: AuthScheme = {type: 'oauth2', flows: {}};

      const result = credentialToParam(authScheme, BEARER_CREDENTIAL);

      expect(result?.param.originalName).toBe('Authorization');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
      });
    });

    it('sends the bearer token of an openIdConnect scheme', () => {
      const authScheme: AuthScheme = {
        type: 'openIdConnect',
        openIdConnectUrl: 'openid_url',
      };

      const result = credentialToParam(authScheme, BEARER_CREDENTIAL);

      expect(result?.param.originalName).toBe('Authorization');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
      });
    });

    it('returns nothing for an openIdConnect scheme with no credential', () => {
      const authScheme: AuthScheme = {
        type: 'openIdConnect',
        openIdConnectUrl: 'openid_url',
      };

      expect(credentialToParam(authScheme)).toBeUndefined();
    });

    it('returns nothing for an oauth2 scheme with no credential', () => {
      const authScheme: AuthScheme = {type: 'oauth2', flows: {}};

      expect(credentialToParam(authScheme)).toBeUndefined();
    });

    it('sends the bearer token of an exchanged oauth2 credential', () => {
      const authScheme: AuthScheme = {type: 'oauth2', flows: {}};
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client_id'},
        http: {scheme: 'bearer', credentials: {token: 'test_token'}},
      };

      const result = credentialToParam(authScheme, authCredential);

      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
      });
    });

    it('returns nothing for an oauth2 credential that holds no token', () => {
      const authScheme: AuthScheme = {type: 'oauth2', flows: {}};
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client_id'},
      };

      expect(credentialToParam(authScheme, authCredential)).toBeUndefined();
    });

    it('rejects a scheme and credential that do not go together', () => {
      const authScheme: AuthScheme = {type: 'http', scheme: 'basic'};

      expect(() => credentialToParam(authScheme, apiKeyCredential)).toThrow(
        'Invalid security scheme and credential combination',
      );
    });

    it('rejects an apiKey scheme whose credential holds no key', () => {
      const authScheme: AuthScheme = {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      };
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
      };

      expect(() => credentialToParam(authScheme, authCredential)).toThrow(
        'Invalid security scheme and credential combination',
      );
    });
  });

  describe('dictToAuthScheme', () => {
    it('converts an apiKey scheme', () => {
      const scheme = dictToAuthScheme({
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'The tenant key.',
      });

      expect(scheme).toEqual({
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'The tenant key.',
      });
    });

    it('converts an http bearer scheme and keeps the bearer format', () => {
      const scheme = dictToAuthScheme({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });

      expect(scheme).toEqual(BEARER_JWT_SCHEME);
    });

    it('converts an http basic scheme', () => {
      const scheme = dictToAuthScheme({type: 'http', scheme: 'basic'});

      expect(scheme).toEqual({type: 'http', scheme: 'basic'});
    });

    it('converts an oauth2 scheme and keeps its flows', () => {
      const scheme = dictToAuthScheme({
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/auth',
            tokenUrl: 'https://example.com/token',
          },
        },
      });

      expect(scheme).toEqual({
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/auth',
            tokenUrl: 'https://example.com/token',
            scopes: {},
          },
        },
      });
    });

    it('keeps the scopes of an implicit flow', () => {
      const scheme = dictToAuthScheme({
        type: 'oauth2',
        flows: {
          implicit: {
            authorizationUrl: 'https://example.com/auth',
            scopes: {read: 'Read access'},
          },
        },
      });

      expect(scheme).toEqual({
        type: 'oauth2',
        flows: {
          implicit: {
            authorizationUrl: 'https://example.com/auth',
            scopes: {read: 'Read access'},
          },
        },
      });
    });

    it('converts an openIdConnect scheme', () => {
      const openIdConnectUrl =
        'https://example.com/.well-known/openid-configuration';

      const scheme = dictToAuthScheme({
        type: 'openIdConnect',
        openIdConnectUrl,
      });

      expect(scheme).toEqual({type: 'openIdConnect', openIdConnectUrl});
    });

    it('rejects a scheme with no type', () => {
      expect(() => dictToAuthScheme({in: 'header', name: 'X-API-Key'})).toThrow(
        "Missing 'type' field in security scheme dictionary.",
      );
    });

    it('rejects an unknown type', () => {
      expect(() =>
        dictToAuthScheme({type: 'invalid', in: 'header', name: 'X-API-Key'}),
      ).toThrow('Invalid security scheme type: invalid');
    });

    it('rejects an apiKey scheme with no name', () => {
      expect(() => dictToAuthScheme({type: 'apiKey', in: 'header'})).toThrow(
        'Invalid security scheme data: name',
      );
    });

    it('rejects an apiKey scheme with an unusable location', () => {
      expect(() =>
        dictToAuthScheme({type: 'apiKey', in: 'body', name: 'X-API-Key'}),
      ).toThrow('Invalid security scheme data: in');
    });

    it('rejects an http scheme with no scheme name', () => {
      expect(() => dictToAuthScheme({type: 'http'})).toThrow(
        'Invalid security scheme data: scheme',
      );
    });

    it('rejects an oauth2 scheme with no flows', () => {
      expect(() => dictToAuthScheme({type: 'oauth2'})).toThrow(
        'Invalid security scheme data: flows',
      );
    });

    it('rejects an openIdConnect scheme with no URL', () => {
      expect(() => dictToAuthScheme({type: 'openIdConnect'})).toThrow(
        'Invalid security scheme data: openIdConnectUrl',
      );
    });
  });
});
