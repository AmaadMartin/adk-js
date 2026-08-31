/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {dictToAuthScheme} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
} from '../../../src/auth/auth_credential.js';
import {
  AuthScheme,
  OpenIdConnectWithConfig,
} from '../../../src/auth/auth_schemes.js';
import {
  createApiKeyScheme,
  createBearerScheme,
  credentialToParam,
  INTERNAL_AUTH_PREFIX,
  OpenIdConfig,
  openIdDictToSchemeCredential,
  openIdUrlToSchemeCredential,
  serviceAccountDictToSchemeCredential,
  serviceAccountSchemeCredential,
  tokenToSchemeCredential,
  validateAuthScheme,
} from '../../../src/tools/openapi_tool/auth/auth_helpers.js';

describe('auth_helpers', () => {
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

  describe('validateAuthScheme', () => {
    it.each([
      ['apiKey', {type: 'apiKey', name: 'X-API-Key', in: 'header'}],
      ['http', {type: 'http', scheme: 'bearer'}],
      [
        'oauth2',
        {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://example.com/auth',
              tokenUrl: 'https://example.com/token',
              scopes: {},
            },
          },
        },
      ],
      [
        'openIdConnect',
        {
          type: 'openIdConnect',
          openIdConnectUrl:
            'https://example.com/.well-known/openid-configuration',
        },
      ],
    ])('should accept a valid %s scheme', (_type, scheme) => {
      expect(() => validateAuthScheme(scheme)).not.toThrow();
    });

    it.each([
      ['a scheme with no type', {name: 'X-API-Key'}],
      ['a scheme that is not an object', null],
      ['a scheme that is a string', 'apiKey'],
    ])('should reject %s', (_label, scheme) => {
      expect(() => validateAuthScheme(scheme)).toThrow(
        "Missing 'type' field in security scheme.",
      );
    });

    it('should reject an unsupported type', () => {
      expect(() => validateAuthScheme({type: 'basic'})).toThrow(
        'Invalid security scheme type: basic',
      );
    });

    it.each([
      [{type: 'apiKey', in: 'header'}, "'name' must be a string"],
      [{type: 'apiKey', name: 'X-API-Key'}, "'in' must be a string"],
      [{type: 'http'}, "'scheme' must be a string"],
      [{type: 'oauth2'}, "'flows' must be an object"],
      [{type: 'oauth2', flows: []}, "'flows' must be an object"],
      [{type: 'openIdConnect'}, "'openIdConnectUrl' must be a string"],
    ])('should reject %j', (scheme, message) => {
      expect(() => validateAuthScheme(scheme)).toThrow(
        `Invalid security scheme data: ${message}.`,
      );
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

  describe('serviceAccountSchemeCredential', () => {
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

    it('should create an OAuth2 client-credentials scheme', () => {
      const {authScheme} = serviceAccountSchemeCredential(config);

      expect(authScheme).toEqual({
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://oauth2.mtls.googleapis.com/token',
            scopes: {},
          },
        },
      });
    });

    it('should carry the service account config on the credential', () => {
      const {authCredential} = serviceAccountSchemeCredential(config);

      expect(authCredential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
      expect(authCredential.serviceAccount).toBe(config);
    });
  });
});

const SERVICE_ACCOUNT_KEY = {
  type: 'service_account',
  project_id: 'project_id',
  private_key_id: 'private_key_id',
  private_key: 'placeholder-private-key',
  client_email: 'sa@project_id.iam.gserviceaccount.com',
  client_id: 'client_id',
  auth_uri: 'https://accounts.example.com/o/oauth2/auth',
  token_uri: 'https://oauth2.example.com/token',
  auth_provider_x509_cert_url: 'https://www.example.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.example.com/robot/v1/metadata/x509/sa',
  universe_domain: 'example.com',
};

const DISCOVERY_DOCUMENT = {
  authorization_endpoint: 'https://accounts.example.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.example.com/token',
  userinfo_endpoint: 'https://openidconnect.example.com/v1/userinfo',
  openIdConnectUrl:
    'https://accounts.example.com/.well-known/openid-configuration',
};

const OAUTH_CLIENT = {
  client_id: 'client_id',
  client_secret: 'client_secret',
  redirect_uri: 'https://app.example.com/callback',
};

const DISCOVERY_URL =
  'https://accounts.example.com/.well-known/openid-configuration';

describe('tokenToSchemeCredential', () => {
  it('builds an apiKey scheme for a header', () => {
    const result = tokenToSchemeCredential(
      'apikey',
      'header',
      'X-API-Key',
      'test_key',
    );

    expect(result.authScheme).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    expect(result.authCredential).toEqual({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test_key',
    });
  });

  it('builds an apiKey scheme for a query parameter', () => {
    const result = tokenToSchemeCredential(
      'apikey',
      'query',
      'api_key',
      'test_key',
    );

    expect(result.authScheme).toEqual({
      type: 'apiKey',
      in: 'query',
      name: 'api_key',
    });
  });

  it('builds an apiKey scheme for a cookie', () => {
    const result = tokenToSchemeCredential(
      'apikey',
      'cookie',
      'session_id',
      'test_key',
    );

    expect(result.authScheme).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: 'session_id',
    });
  });

  it('omits the credential when no api key value is given', () => {
    const result = tokenToSchemeCredential('apikey', 'header', 'X-API-Key');

    expect(result.authScheme).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    expect(result.authCredential).toBeUndefined();
  });

  it('omits the credential when the api key value is an empty string', () => {
    const result = tokenToSchemeCredential('apikey', 'header', 'X-API-Key', '');

    expect(result.authCredential).toBeUndefined();
  });

  it('defaults the api key name to an empty string', () => {
    const result = tokenToSchemeCredential('apikey', 'header');

    expect(result.authScheme).toEqual({type: 'apiKey', in: 'header', name: ''});
  });

  it('rejects an unsupported api key location', () => {
    expect(() =>
      tokenToSchemeCredential('apikey', 'body', 'X-API-Key', 'test_key'),
    ).toThrow('Invalid location for apiKey: body');
  });

  it('rejects an omitted api key location', () => {
    expect(() => tokenToSchemeCredential('apikey')).toThrow(
      'Invalid location for apiKey: undefined',
    );
  });

  it('builds a bearer scheme and ignores the location and name', () => {
    const result = tokenToSchemeCredential(
      'oauth2Token',
      'query',
      'ignored',
      'test_token',
    );

    expect(result.authScheme).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(result.authCredential).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    });
  });

  it('omits the credential when no token value is given', () => {
    const result = tokenToSchemeCredential('oauth2Token');

    expect(result.authScheme).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(result.authCredential).toBeUndefined();
  });

  it('rejects an unsupported token type', () => {
    expect(() =>
      tokenToSchemeCredential('basic', 'header', 'X-API-Key'),
    ).toThrow('Invalid security scheme type: basic');
  });
});

describe('serviceAccountSchemeCredential', () => {
  it('returns an oauth2 client-credentials scheme and the credential', () => {
    const config: ServiceAccount = {useDefaultCredential: true, scopes: ['a']};

    const result = serviceAccountSchemeCredential(config);

    expect(result.authScheme.type).toBe('oauth2');
    expect(result.authCredential.authType).toBe(
      AuthCredentialTypes.SERVICE_ACCOUNT,
    );
    expect(result.authCredential.serviceAccount).toBe(config);
  });

  it('uses the mTLS token url and never an http bearer scheme', () => {
    const result = serviceAccountSchemeCredential({useDefaultCredential: true});

    expect(result.authScheme.type).not.toBe('http');
    expect(result.authScheme.flows.clientCredentials?.tokenUrl).toBe(
      'https://oauth2.mtls.googleapis.com/token',
    );
    expect(result.authScheme.flows.clientCredentials?.scopes).toEqual({});
  });
});

describe('serviceAccountDictToSchemeCredential', () => {
  it('keeps a field the credential type does not declare', () => {
    const result = serviceAccountDictToSchemeCredential(
      {...SERVICE_ACCOUNT_KEY, future_field: 'future_value'},
      [],
    );

    expect(
      result.authCredential.serviceAccount?.serviceAccountCredential,
    ).toMatchObject({futureField: 'future_value'});
  });

  it('rejects a key that is missing fields the exchange needs', () => {
    const build = () =>
      serviceAccountDictToSchemeCredential({project_id: 'project_id'}, []);

    expect(build).toThrow('Invalid service account key:');
    expect(build).toThrow('clientEmail');
    expect(build).toThrow('privateKey');
  });

  it('maps a downloaded key to a camelCase credential', () => {
    const scopes = ['https://www.googleapis.com/auth/cloud-platform'];

    const result = serviceAccountDictToSchemeCredential(
      SERVICE_ACCOUNT_KEY,
      scopes,
    );

    expect(result.authScheme.flows.clientCredentials?.tokenUrl).toBeTruthy();
    expect(result.authCredential.authType).toBe(
      AuthCredentialTypes.SERVICE_ACCOUNT,
    );
    expect(result.authCredential.serviceAccount?.scopes).toEqual(scopes);
    const credential =
      result.authCredential.serviceAccount?.serviceAccountCredential;
    expect(credential?.projectId).toBe('project_id');
    expect(credential?.privateKeyId).toBe('private_key_id');
    expect(credential?.authProviderX509CertUrl).toBe(
      'https://www.example.com/oauth2/v1/certs',
    );
  });
});

describe('openIdDictToSchemeCredential', () => {
  it('builds the scheme and the credential from snake_case input', () => {
    const result = openIdDictToSchemeCredential(
      DISCOVERY_DOCUMENT,
      ['openid', 'email'],
      OAUTH_CLIENT,
    );

    expect(result.authScheme).toEqual({
      type: 'openIdConnect',
      authorizationEndpoint: DISCOVERY_DOCUMENT.authorization_endpoint,
      tokenEndpoint: DISCOVERY_DOCUMENT.token_endpoint,
      userinfoEndpoint: DISCOVERY_DOCUMENT.userinfo_endpoint,
      openIdConnectUrl: DISCOVERY_URL,
      scopes: ['openid', 'email'],
    });
    expect(result.authCredential).toEqual({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: 'client_id',
        clientSecret: 'client_secret',
        redirectUri: 'https://app.example.com/callback',
      },
    });
  });

  it('defaults the discovery url to an empty string', () => {
    const {openIdConnectUrl, ...configWithoutUrl} = DISCOVERY_DOCUMENT;
    expect(openIdConnectUrl).toBeTruthy();

    const result = openIdDictToSchemeCredential(
      configWithoutUrl,
      ['openid'],
      OAUTH_CLIENT,
    );

    expect(result.authScheme.openIdConnectUrl).toBe('');
  });

  it('accepts camelCase configuration keys', () => {
    const result = openIdDictToSchemeCredential(
      {
        authorizationEndpoint: DISCOVERY_DOCUMENT.authorization_endpoint,
        tokenEndpoint: DISCOVERY_DOCUMENT.token_endpoint,
      },
      ['openid'],
      OAUTH_CLIENT,
    );

    expect(result.authScheme.authorizationEndpoint).toBe(
      DISCOVERY_DOCUMENT.authorization_endpoint,
    );
  });

  it('omits redirectUri when the client does not carry one', () => {
    const result = openIdDictToSchemeCredential(
      DISCOVERY_DOCUMENT,
      ['openid'],
      {client_id: 'client_id', client_secret: 'client_secret'},
    );

    expect(result.authCredential.oauth2).toEqual({
      clientId: 'client_id',
      clientSecret: 'client_secret',
    });
  });

  it('unwraps a client downloaded from the cloud console', () => {
    const result = openIdDictToSchemeCredential(
      DISCOVERY_DOCUMENT,
      ['openid'],
      {web: OAUTH_CLIENT},
    );

    expect(result.authCredential.oauth2).toEqual({
      clientId: 'client_id',
      clientSecret: 'client_secret',
      redirectUri: 'https://app.example.com/callback',
    });
  });

  it('does not unwrap a single key that is not an oauth client', () => {
    expect(() =>
      openIdDictToSchemeCredential(DISCOVERY_DOCUMENT, ['openid'], {
        something: 'x',
      }),
    ).toThrow('Missing required fields in credential: clientId, clientSecret');
  });

  it('rejects a configuration with no endpoints', () => {
    expect(() =>
      openIdDictToSchemeCredential(
        {invalid_field: 'value'},
        ['openid'],
        OAUTH_CLIENT,
      ),
    ).toThrow('Invalid OpenID Connect configuration');
  });

  it('rejects an empty authorization endpoint', () => {
    expect(() =>
      openIdDictToSchemeCredential(
        {...DISCOVERY_DOCUMENT, authorization_endpoint: ''},
        ['openid'],
        OAUTH_CLIENT,
      ),
    ).toThrow('Invalid OpenID Connect configuration: authorizationEndpoint');
  });

  it('names the single missing credential field', () => {
    expect(() =>
      openIdDictToSchemeCredential(DISCOVERY_DOCUMENT, ['openid'], {
        client_id: 'client_id',
        redirect_uri: 'https://app.example.com/callback',
      }),
    ).toThrow('Missing required fields in credential: clientSecret');
  });

  it('names every missing credential field', () => {
    expect(() =>
      openIdDictToSchemeCredential(DISCOVERY_DOCUMENT, ['openid'], {}),
    ).toThrow('Missing required fields in credential: clientId, clientSecret');
  });
});

describe('openIdUrlToSchemeCredential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the discovery document and builds the scheme', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ok: true, json: async () => DISCOVERY_DOCUMENT});
    vi.stubGlobal('fetch', fetchMock);

    const result = await openIdUrlToSchemeCredential(
      DISCOVERY_URL,
      ['openid'],
      OAUTH_CLIENT,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(DISCOVERY_URL);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
    expect(result.authScheme.tokenEndpoint).toBe(
      DISCOVERY_DOCUMENT.token_endpoint,
    );
    expect(result.authScheme.scopes).toEqual(['openid']);
    expect(result.authCredential.oauth2?.clientId).toBe('client_id');
  });

  it('carries the discovery url onto the scheme', async () => {
    const {openIdConnectUrl, ...bodyWithoutUrl} = DISCOVERY_DOCUMENT;
    expect(openIdConnectUrl).toBeTruthy();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ok: true, json: async () => bodyWithoutUrl}),
    );

    const result = await openIdUrlToSchemeCredential(
      DISCOVERY_URL,
      ['openid'],
      OAUTH_CLIENT,
    );

    expect(result.authScheme.openIdConnectUrl).toBe(DISCOVERY_URL);
  });

  it('reports a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connection refused')),
    );

    await expect(
      openIdUrlToSchemeCredential(DISCOVERY_URL, ['openid'], OAUTH_CLIENT),
    ).rejects.toThrow(
      `Failed to fetch OpenID configuration from ${DISCOVERY_URL}: connection refused`,
    );
  });

  it('reports a non-2xx response with its status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: false, status: 404}));

    await expect(
      openIdUrlToSchemeCredential(DISCOVERY_URL, ['openid'], OAUTH_CLIENT),
    ).rejects.toThrow(
      `Failed to fetch OpenID configuration from ${DISCOVERY_URL}: HTTP 404`,
    );
  });

  it('reports a body that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }),
    );

    await expect(
      openIdUrlToSchemeCredential(DISCOVERY_URL, ['openid'], OAUTH_CLIENT),
    ).rejects.toThrow(
      `Invalid JSON response from OpenID configuration endpoint ${DISCOVERY_URL}: Unexpected token <`,
    );
  });

  it('reports a JSON body that is not an object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ['not', 'an', 'object'],
      }),
    );

    await expect(
      openIdUrlToSchemeCredential(DISCOVERY_URL, ['openid'], OAUTH_CLIENT),
    ).rejects.toThrow('the body is not a JSON object');
  });

  it('rejects a private discovery url before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      openIdUrlToSchemeCredential(
        'http://localhost/.well-known/openid-configuration',
        ['openid'],
        OAUTH_CLIENT,
      ),
    ).rejects.toThrow('must be a public HTTPS endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('INTERNAL_AUTH_PREFIX', () => {
  it('matches the literal adk-python uses', () => {
    expect(INTERNAL_AUTH_PREFIX).toBe('_auth_prefix_vaf_');
  });
});

describe('credentialToParam', () => {
  const apiKeyCredential: AuthCredential = {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: 'test_key',
  };
  const bearerCredential: AuthCredential = {
    authType: AuthCredentialTypes.HTTP,
    http: {scheme: 'bearer', credentials: {token: 'test_token'}},
  };
  const openIdScheme: OpenIdConnectWithConfig = {
    type: 'openIdConnect',
    openIdConnectUrl: DISCOVERY_URL,
    authorizationEndpoint: DISCOVERY_DOCUMENT.authorization_endpoint,
    tokenEndpoint: DISCOVERY_DOCUMENT.token_endpoint,
  };
  const oauth2Scheme: AuthScheme = {
    type: 'oauth2',
    flows: {
      clientCredentials: {
        tokenUrl: 'https://oauth2.example.com/token',
        scopes: {},
      },
    },
  };

  it('returns undefined without a credential', () => {
    expect(credentialToParam(createBearerScheme())).toBeUndefined();
  });

  it('builds a header parameter for an api key', () => {
    const result = credentialToParam(
      {type: 'apiKey', in: 'header', name: 'X-API-Key'},
      apiKeyCredential,
    );

    expect(result?.param).toEqual({
      originalName: 'X-API-Key',
      paramLocation: 'header',
      paramSchema: {type: 'string'},
      description: '',
      name: `${INTERNAL_AUTH_PREFIX}X-API-Key`,
      required: true,
    });
    expect(result?.kwargs).toEqual({
      '_auth_prefix_vaf_X-API-Key': 'test_key',
    });
  });

  it('builds a query parameter for an api key', () => {
    const result = credentialToParam(
      {type: 'apiKey', in: 'query', name: 'api_key'},
      apiKeyCredential,
    );

    expect(result?.param.paramLocation).toBe('query');
    expect(result?.param.originalName).toBe('api_key');
    expect(result?.kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}api_key`]: 'test_key',
    });
  });

  it('builds a cookie parameter for an api key', () => {
    const result = credentialToParam(
      {type: 'apiKey', in: 'cookie', name: 'session_id'},
      apiKeyCredential,
    );

    expect(result?.param.paramLocation).toBe('cookie');
    expect(result?.kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}session_id`]: 'test_key',
    });
  });

  it('carries the scheme description onto an api key parameter', () => {
    const result = credentialToParam(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'The tenant key.',
      },
      apiKeyCredential,
    );

    expect(result?.param.description).toBe('The tenant key.');
  });

  it('rejects an unsupported api key location', () => {
    expect(() =>
      credentialToParam(
        {type: 'apiKey', in: 'body', name: 'X-API-Key'},
        apiKeyCredential,
      ),
    ).toThrow('Invalid API Key location: body');
  });

  it('builds an Authorization parameter for a bearer token', () => {
    const result = credentialToParam(createBearerScheme(), bearerCredential);

    expect(result?.param).toEqual({
      originalName: 'Authorization',
      paramLocation: 'header',
      paramSchema: {type: 'string'},
      description: 'Bearer token',
      name: `${INTERNAL_AUTH_PREFIX}Authorization`,
      required: true,
    });
    expect(result?.kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('carries the scheme description onto an Authorization parameter', () => {
    const result = credentialToParam(
      {type: 'http', scheme: 'bearer', description: 'The tenant token.'},
      bearerCredential,
    );

    expect(result?.param.description).toBe('The tenant token.');
  });

  it('rejects basic authentication', () => {
    expect(() =>
      credentialToParam(
        {type: 'http', scheme: 'basic'},
        {
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'basic',
            credentials: {username: 'user', password: 'pass'},
          },
        },
      ),
    ).toThrow('Basic Authentication is not supported.');
  });

  it('rejects an http credential with a username and no password', () => {
    expect(() =>
      credentialToParam(
        {type: 'http', scheme: 'basic'},
        {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'basic', credentials: {username: 'user'}},
        },
      ),
    ).toThrow('Basic Authentication is not supported.');
  });

  it('rejects an http credential with a password and no username', () => {
    expect(() =>
      credentialToParam(
        {type: 'http', scheme: 'basic'},
        {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'basic', credentials: {password: 'pass'}},
        },
      ),
    ).toThrow('Basic Authentication is not supported.');
  });

  it('rejects an http credential with no http block', () => {
    expect(() =>
      credentialToParam(createBearerScheme(), {
        authType: AuthCredentialTypes.HTTP,
      }),
    ).toThrow('Invalid HTTP auth credentials');
  });

  it('builds an Authorization parameter for an oauth2 scheme', () => {
    const result = credentialToParam(oauth2Scheme, bearerCredential);

    expect(result?.kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer test_token',
    });
  });

  it('builds an Authorization parameter for an openIdConnect scheme', () => {
    const result = credentialToParam(openIdScheme, bearerCredential);

    expect(result?.param.originalName).toBe('Authorization');
  });

  it('returns undefined for an openIdConnect scheme with no credential', () => {
    expect(credentialToParam(openIdScheme)).toBeUndefined();
  });

  it('returns undefined for an oauth2 scheme with no credential', () => {
    expect(credentialToParam(oauth2Scheme)).toBeUndefined();
  });

  it('builds an Authorization parameter for an exchanged oauth2 credential', () => {
    const result = credentialToParam(oauth2Scheme, {
      authType: AuthCredentialTypes.OAUTH2,
      http: {scheme: 'bearer', credentials: {token: 'exchanged_token'}},
    });

    expect(result?.param.originalName).toBe('Authorization');
    expect(result?.kwargs).toEqual({
      [`${INTERNAL_AUTH_PREFIX}Authorization`]: 'Bearer exchanged_token',
    });
  });

  it('returns undefined for an oauth2 credential that holds no token', () => {
    const result = credentialToParam(oauth2Scheme, {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client_id'},
    });

    expect(result).toBeUndefined();
  });

  it('rejects a scheme and credential that do not go together', () => {
    expect(() =>
      credentialToParam(
        {type: 'http', scheme: 'basic'},
        {authType: AuthCredentialTypes.API_KEY},
      ),
    ).toThrow('Invalid security scheme and credential combination');
  });
});

describe('OpenIdConfig', () => {
  const discoveryDocument = {
    authorization_endpoint: 'https://example.com/auth',
    token_endpoint: 'https://example.com/token',
  };

  it('types a client that openIdDictToSchemeCredential accepts', () => {
    const client: OpenIdConfig = {
      clientId: 'client_id',
      authUri: 'https://example.com/auth',
      tokenUri: 'https://example.com/token',
      clientSecret: 'client_secret',
      redirectUri: 'https://example.com/callback',
    };

    const {authCredential} = openIdDictToSchemeCredential(
      discoveryDocument,
      ['openid'],
      client,
    );

    expect(authCredential.oauth2).toEqual({
      clientId: 'client_id',
      clientSecret: 'client_secret',
      redirectUri: 'https://example.com/callback',
    });
  });

  it('types a client whose redirect uri is absent', () => {
    const client: OpenIdConfig = {
      clientId: 'client_id',
      authUri: 'https://example.com/auth',
      tokenUri: 'https://example.com/token',
      clientSecret: 'client_secret',
    };

    const {authCredential} = openIdDictToSchemeCredential(
      discoveryDocument,
      [],
      client,
    );

    expect(authCredential.oauth2).toEqual({
      clientId: 'client_id',
      clientSecret: 'client_secret',
    });
  });
});
