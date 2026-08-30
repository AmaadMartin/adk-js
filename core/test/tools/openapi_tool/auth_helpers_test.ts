/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
} from '../../../src/auth/auth_credential.js';
import {OpenIdConnectWithConfig} from '../../../src/auth/auth_schemes.js';
import {
  INTERNAL_AUTH_PREFIX,
  OpenIdConfig,
  TokenType,
  applyCredential,
  createApiKeyScheme,
  createBearerScheme,
  credentialToParam,
  openidDictToSchemeCredential,
  openidUrlToSchemeCredential,
  serviceAccountDictToSchemeCredential,
  serviceAccountSchemeCredential,
  tokenToSchemeCredential,
} from '../../../src/tools/openapi_tool/auth/auth_helpers.js';

/** Token types as a configuration file would supply them, keyed by name. */
const CONFIGURED_TOKEN_TYPES: Record<string, TokenType> = {
  apikey: 'apikey',
  oauth2Token: 'oauth2Token',
};

/** A service account key file, as Google writes it. */
const SERVICE_ACCOUNT_KEY = {
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

/** An OpenID Connect discovery document, as a provider publishes it. */
const OPENID_DOCUMENT = {
  authorization_endpoint: 'auth_url',
  token_endpoint: 'token_url',
  userinfo_endpoint: 'userinfo_url',
  token_endpoint_auth_methods_supported: ['client_secret_basic'],
  openIdConnectUrl: 'openid_url',
};

const OPENID_SCHEME: OpenIdConnectWithConfig = {
  type: 'openIdConnect',
  openIdConnectUrl: 'openid_url',
  authorizationEndpoint: 'auth_url',
  tokenEndpoint: 'token_url',
};

function bearerCredential(token: string): AuthCredential {
  return {
    authType: AuthCredentialTypes.HTTP,
    http: {scheme: 'bearer', credentials: {token}},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
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
    it('builds an API key scheme for a header', () => {
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

    it('builds an API key scheme for a query parameter', () => {
      const {authScheme} = tokenToSchemeCredential(
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
    });

    it('builds an API key scheme for a cookie', () => {
      const {authScheme} = tokenToSchemeCredential(
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
    });

    it('omits the credential when no API key is supplied', () => {
      const {authScheme, authCredential} = tokenToSchemeCredential(
        'apikey',
        'header',
        'X-API-Key',
      );

      expect(authScheme).toEqual({
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      });
      expect(authCredential).toBeUndefined();
    });

    it('builds a bearer scheme for an OAuth2 token', () => {
      const {authScheme, authCredential} = tokenToSchemeCredential(
        'oauth2Token',
        'header',
        'Authorization',
        'test_token',
      );

      expect(authScheme).toEqual({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'test_token'}},
      });
    });

    it('omits the credential when no OAuth2 token is supplied', () => {
      const {authScheme, authCredential} =
        tokenToSchemeCredential('oauth2Token');

      expect(authScheme).toEqual({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
      expect(authCredential).toBeUndefined();
    });

    it('rejects an API key location the OpenAPI specification does not define', () => {
      expect(() =>
        tokenToSchemeCredential('apikey', undefined, 'X-API-Key', 'test_key'),
      ).toThrow('Invalid location for apiKey: undefined');
    });

    it('rejects an API key scheme without a name', () => {
      expect(() => tokenToSchemeCredential('apikey', 'header')).toThrow(
        'Missing name for apiKey scheme',
      );
    });

    it('rejects a token type it does not support', () => {
      // A token type read from configuration is a string at runtime, so the
      // final branch stays reachable without a cast.
      const tokenType = CONFIGURED_TOKEN_TYPES['basic'];

      expect(() => tokenToSchemeCredential(tokenType)).toThrow(
        /Invalid security scheme type:/,
      );
    });
  });

  describe('serviceAccountDictToSchemeCredential', () => {
    it('reads a service account key file written in snake_case', () => {
      const {authScheme, authCredential} = serviceAccountDictToSchemeCredential(
        SERVICE_ACCOUNT_KEY,
        ['scope1', 'scope2'],
      );

      expect(authScheme.type).toBe('oauth2');
      expect(authScheme.flows.clientCredentials?.tokenUrl).toBeTruthy();
      expect(authCredential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
      expect(authCredential.serviceAccount?.scopes).toEqual([
        'scope1',
        'scope2',
      ]);
      expect(
        authCredential.serviceAccount?.serviceAccountCredential?.projectId,
      ).toBe('project_id');
    });

    it('reads a service account key file already written in camelCase', () => {
      const {authCredential} = serviceAccountDictToSchemeCredential(
        {
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
        ['scope1'],
      );

      expect(
        authCredential.serviceAccount?.serviceAccountCredential?.projectId,
      ).toBe('project_id');
    });

    it('names the field a service account key file is missing', () => {
      const {private_key: _omitted, ...incomplete} = SERVICE_ACCOUNT_KEY;

      expect(() =>
        serviceAccountDictToSchemeCredential(incomplete, ['scope1']),
      ).toThrow(/Invalid service account configuration:.*privateKey/);
    });
  });

  describe('serviceAccountSchemeCredential', () => {
    it('passes the service account through unchanged', () => {
      const config: ServiceAccount = {
        scopes: ['scope1'],
        useDefaultCredential: true,
      };

      const {authScheme, authCredential} =
        serviceAccountSchemeCredential(config);

      expect(authScheme.type).toBe('oauth2');
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: config,
      });
    });

    it('returns an OAuth2 client-credentials scheme', () => {
      // A credential manager exchanges a raw service account on its own only
      // for a client-credentials flow. An HTTP bearer scheme here makes the
      // tool ask the client to authorize interactively instead.
      const {authScheme} = serviceAccountSchemeCredential({
        useDefaultCredential: true,
      });

      expect(authScheme.type).toBe('oauth2');
      expect(authScheme.flows.clientCredentials).toBeDefined();
    });
  });

  describe('openidDictToSchemeCredential', () => {
    it('maps a snake_case discovery document to a scheme', () => {
      const {authScheme, authCredential} = openidDictToSchemeCredential(
        OPENID_DOCUMENT,
        ['scope1', 'scope2'],
        {
          client_id: 'client_id',
          client_secret: 'client_secret',
          redirect_uri: 'redirect_uri',
        },
      );

      expect(authScheme).toEqual({
        type: 'openIdConnect',
        openIdConnectUrl: 'openid_url',
        authorizationEndpoint: 'auth_url',
        tokenEndpoint: 'token_url',
        userinfoEndpoint: 'userinfo_url',
        tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
        scopes: ['scope1', 'scope2'],
      });
      expect(authCredential).toEqual({
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {
          clientId: 'client_id',
          clientSecret: 'client_secret',
          redirectUri: 'redirect_uri',
        },
      });
    });

    it('defaults the discovery URL of a static configuration to an empty string', () => {
      const {authScheme} = openidDictToSchemeCredential(
        {authorization_endpoint: 'auth_url', token_endpoint: 'token_url'},
        ['scope1'],
        {client_id: 'client_id', client_secret: 'client_secret'},
      );

      expect(authScheme.openIdConnectUrl).toBe('');
    });

    it('leaves the redirect URI undefined when the client omits it', () => {
      const {authCredential} = openidDictToSchemeCredential(
        OPENID_DOCUMENT,
        ['scope1'],
        {client_id: 'client_id', client_secret: 'client_secret'},
      );

      expect(authCredential.oauth2?.redirectUri).toBeUndefined();
    });

    it('unwraps a client secret file downloaded from Google', () => {
      const {authCredential} = openidDictToSchemeCredential(
        OPENID_DOCUMENT,
        ['scope1'],
        {
          web: {
            client_id: 'client_id',
            client_secret: 'client_secret',
            redirect_uri: 'redirect_uri',
          },
        },
      );

      expect(authCredential.oauth2).toEqual({
        clientId: 'client_id',
        clientSecret: 'client_secret',
        redirectUri: 'redirect_uri',
      });
    });

    it('does not unwrap a single-entry client that holds no client secret', () => {
      expect(() =>
        openidDictToSchemeCredential(OPENID_DOCUMENT, ['scope1'], {
          web: {client_id: 'client_id'},
        }),
      ).toThrow(/Missing required fields in credentialDict:/);
    });

    it('rejects a configuration with no endpoints', () => {
      expect(() =>
        openidDictToSchemeCredential({invalid_field: 'value'}, ['scope1'], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).toThrow(/Invalid OpenID Connect configuration:/);
    });

    it('names the field the client is missing', () => {
      expect(() =>
        openidDictToSchemeCredential(OPENID_DOCUMENT, ['scope1'], {
          client_id: 'client_id',
        }),
      ).toThrow('Missing required fields in credentialDict: clientSecret');
    });
  });

  describe('openidUrlToSchemeCredential', () => {
    const originalFetch = globalThis.fetch;
    const url = 'https://example.com/.well-known/openid-configuration';

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('fetches the discovery document without following a redirect', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(OPENID_DOCUMENT));
      globalThis.fetch = fetchMock;

      const {authScheme, authCredential} = await openidUrlToSchemeCredential(
        url,
        ['scope1'],
        {client_id: 'client_id', client_secret: 'client_secret'},
      );

      expect(fetchMock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({redirect: 'error'}),
      );
      expect(authScheme.authorizationEndpoint).toBe('auth_url');
      expect(authScheme.tokenEndpoint).toBe('token_url');
      expect(authScheme.scopes).toEqual(['scope1']);
      expect(authCredential.oauth2?.clientId).toBe('client_id');
    });

    it('overrides the discovery URL the document declares', async () => {
      globalThis.fetch = vi.fn(async () => jsonResponse(OPENID_DOCUMENT));

      const {authScheme} = await openidUrlToSchemeCredential(url, ['scope1'], {
        client_id: 'client_id',
        client_secret: 'client_secret',
      });

      expect(OPENID_DOCUMENT.openIdConnectUrl).toBe('openid_url');
      expect(authScheme.openIdConnectUrl).toBe(url);
    });

    it('reports a request that fails', async () => {
      globalThis.fetch = vi.fn(() =>
        Promise.reject(new Error('connection refused')),
      );

      await expect(
        openidUrlToSchemeCredential(url, ['scope1'], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).rejects.toThrow(
        `Failed to fetch OpenID configuration from ${url}: connection refused`,
      );
    });

    it('reports a rejection that is not an Error', async () => {
      globalThis.fetch = vi.fn(() => Promise.reject('connection refused'));

      await expect(
        openidUrlToSchemeCredential(url, ['scope1'], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).rejects.toThrow(
        `Failed to fetch OpenID configuration from ${url}: connection refused`,
      );
    });

    it('reports a response that is not successful', async () => {
      globalThis.fetch = vi.fn(async () => new Response('', {status: 404}));

      await expect(
        openidUrlToSchemeCredential(url, ['scope1'], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).rejects.toThrow(
        `Failed to fetch OpenID configuration from ${url}: HTTP 404`,
      );
    });

    it('reports a response that is not JSON', async () => {
      globalThis.fetch = vi.fn(async () => new Response('not json'));

      await expect(
        openidUrlToSchemeCredential(url, ['scope1'], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).rejects.toThrow(
        `Invalid JSON response from OpenID configuration endpoint ${url}:`,
      );
    });

    it('reports a JSON response that is not an object', async () => {
      globalThis.fetch = vi.fn(async () => jsonResponse(['not', 'an object']));

      await expect(
        openidUrlToSchemeCredential(url, ['scope1'], {
          client_id: 'client_id',
          client_secret: 'client_secret',
        }),
      ).rejects.toThrow(
        `Invalid JSON response from OpenID configuration endpoint ${url}:`,
      );
    });
  });

  describe('credentialToParam', () => {
    it('prefixes an injected argument the way the other ADK languages do', () => {
      // A tool declaration crosses the language boundary, so the literal
      // matters. Every other assertion here builds its key from the constant.
      expect(INTERNAL_AUTH_PREFIX).toBe('_auth_prefix_vaf_');
    });

    it('injects an API key into a header', () => {
      const result = credentialToParam(
        {type: 'apiKey', in: 'header', name: 'X-API-Key'},
        {authType: AuthCredentialTypes.API_KEY, apiKey: 'test_key'},
      );

      expect(result?.param.originalName).toBe('X-API-Key');
      expect(result?.param.paramLocation).toBe('header');
      expect(result?.param.description).toBe('');
      expect(result?.param.required).toBe(false);
      expect(result?.param.name).toBe('_auth_prefix_vaf_X-API-Key');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}X-API-Key`]: 'test_key',
      });
    });

    it('injects an API key into a query parameter', () => {
      const result = credentialToParam(
        {
          type: 'apiKey',
          in: 'query',
          name: 'api_key',
          description: 'The API key.',
        },
        {authType: AuthCredentialTypes.API_KEY, apiKey: 'test_key'},
      );

      expect(result?.param.paramLocation).toBe('query');
      expect(result?.param.description).toBe('The API key.');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}api_key`]: 'test_key',
      });
    });

    it('injects an API key into a cookie', () => {
      const result = credentialToParam(
        {type: 'apiKey', in: 'cookie', name: 'session_id'},
        {authType: AuthCredentialTypes.API_KEY, apiKey: 'test_key'},
      );

      expect(result?.param.paramLocation).toBe('cookie');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}session_id`]: 'test_key',
      });
    });

    it('injects a bearer token into the Authorization header', () => {
      const result = credentialToParam(
        {type: 'http', scheme: 'bearer'},
        bearerCredential('test_token'),
      );

      expect(result?.param.originalName).toBe('Authorization');
      expect(result?.param.paramLocation).toBe('header');
      expect(result?.param.description).toBe('Bearer token');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
      });
    });

    it('injects an exchanged OAuth2 credential as a bearer token', () => {
      const result = credentialToParam(
        {
          type: 'oauth2',
          description: 'OAuth2.',
          flows: {clientCredentials: {tokenUrl: 'token_url', scopes: {}}},
        },
        bearerCredential('test_token'),
      );

      expect(result?.param.originalName).toBe('Authorization');
      expect(result?.param.description).toBe('OAuth2.');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
      });
    });

    it('injects an exchanged OpenID Connect credential as a bearer token', () => {
      const result = credentialToParam(
        OPENID_SCHEME,
        bearerCredential('test_token'),
      );

      expect(result?.param.originalName).toBe('Authorization');
      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
      });
    });

    it('injects a bearer token an OAuth2 credential already carries', () => {
      const result = credentialToParam(OPENID_SCHEME, {
        authType: AuthCredentialTypes.OAUTH2,
        http: {scheme: 'bearer', credentials: {token: 'test_token'}},
      });

      expect(result?.kwargs).toEqual({
        [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
      });
    });

    it('injects nothing for an OAuth2 scheme with no credential', () => {
      expect(
        credentialToParam({
          type: 'oauth2',
          flows: {clientCredentials: {tokenUrl: 'token_url', scopes: {}}},
        }),
      ).toBeUndefined();
    });

    it('injects nothing for an OpenID Connect scheme with no credential', () => {
      expect(credentialToParam(OPENID_SCHEME)).toBeUndefined();
    });

    it('injects nothing before an OpenID Connect credential is exchanged', () => {
      expect(
        credentialToParam(OPENID_SCHEME, {
          authType: AuthCredentialTypes.OPEN_ID_CONNECT,
          oauth2: {clientId: 'client_id', clientSecret: 'client_secret'},
        }),
      ).toBeUndefined();
    });

    it('rejects HTTP basic credentials', () => {
      expect(() =>
        credentialToParam(
          {type: 'http', scheme: 'basic'},
          {
            authType: AuthCredentialTypes.HTTP,
            http: {
              scheme: 'basic',
              credentials: {username: 'user', password: 'password'},
            },
          },
        ),
      ).toThrow('Basic Authentication is not supported.');
    });

    it('rejects an HTTP credential that holds only a password', () => {
      expect(() =>
        credentialToParam(
          {type: 'http', scheme: 'basic'},
          {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'basic', credentials: {password: 'password'}},
          },
        ),
      ).toThrow('Basic Authentication is not supported.');
    });

    it('rejects an HTTP credential that holds nothing usable', () => {
      expect(() =>
        credentialToParam(
          {type: 'http', scheme: 'bearer'},
          {authType: AuthCredentialTypes.HTTP},
        ),
      ).toThrow('Invalid HTTP auth credentials');
    });

    it('rejects an API key location the OpenAPI specification does not define', () => {
      expect(() =>
        credentialToParam(
          {type: 'apiKey', in: 'body', name: 'X-API-Key'},
          {authType: AuthCredentialTypes.API_KEY, apiKey: 'test_key'},
        ),
      ).toThrow('Invalid API Key location: body');
    });

    it('rejects a scheme and a credential that do not go together', () => {
      expect(() =>
        credentialToParam(
          {type: 'apiKey', in: 'header', name: 'X-API-Key'},
          {
            authType: AuthCredentialTypes.SERVICE_ACCOUNT,
            serviceAccount: {useDefaultCredential: true},
          },
        ),
      ).toThrow('Invalid security scheme and credential combination');
    });
  });

  describe('OpenIdConfig', () => {
    it('names the fields of an OpenID Connect client', () => {
      // An interface is erased at compile time, so this pins the field names
      // through the type checker rather than at run time.
      const config: OpenIdConfig = {
        clientId: 'client_id',
        authUri: 'auth_uri',
        tokenUri: 'token_uri',
        clientSecret: 'client_secret',
        redirectUri: 'redirect_uri',
      };

      expect(config.clientId).toBe('client_id');
    });
  });
});
