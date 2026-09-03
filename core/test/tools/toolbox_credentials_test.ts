/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  ToolboxCredentialConfig,
  ToolboxCredentialStrategy,
  ToolboxCredentialType,
  ToolboxHeaderValue,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  credentialClientHeaders,
  userIdentityAuthConfig,
} from '../../src/tools/toolbox_credentials.js';

const auth = vi.hoisted(() => ({
  /** Set to make `fetchIdToken` reject, as a server with no metadata does. */
  idTokenError: undefined as Error | undefined,
  idToken: 'id-token',
  accessToken: 'access-token' as string | null,
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getIdTokenClient() {
      return {
        idTokenProvider: {
          fetchIdToken: async () => {
            if (auth.idTokenError) {
              throw auth.idTokenError;
            }
            return auth.idToken;
          },
        },
      };
    }
    async getAccessToken() {
      return auth.accessToken;
    }
  },
}));

const NO_USER_TOKEN = () => undefined;

/** Resolves one header value, whether it is a string or a getter. */
async function resolve(value: ToolboxHeaderValue): Promise<string> {
  return typeof value === 'function' ? value() : value;
}

/** Resolves the single header a credential produces. */
async function singleHeader(
  config: ToolboxCredentialConfig,
  readUserToken: () => string | undefined = NO_USER_TOKEN,
): Promise<[string, string]> {
  const headers = credentialClientHeaders(config, readUserToken);
  const entries = Object.entries(headers);
  expect(entries).toHaveLength(1);
  return [entries[0][0], await resolve(entries[0][1])];
}

afterEach(() => {
  auth.idTokenError = undefined;
  auth.idToken = 'id-token';
  auth.accessToken = 'access-token';
});

describe('ToolboxCredentialStrategy factories', () => {
  it('builds a toolbox identity carrying nothing else', () => {
    expect(ToolboxCredentialStrategy.toolboxIdentity()).toEqual({
      type: ToolboxCredentialType.TOOLBOX_IDENTITY,
    });
  });

  it('builds a workload identity for the target audience', () => {
    expect(
      ToolboxCredentialStrategy.workloadIdentity('https://toolbox.example.com'),
    ).toEqual({
      type: ToolboxCredentialType.WORKLOAD_IDENTITY,
      targetAudience: 'https://toolbox.example.com',
    });
  });

  it('treats applicationDefaultCredentials as workloadIdentity', () => {
    expect(
      ToolboxCredentialStrategy.applicationDefaultCredentials('aud'),
    ).toEqual(ToolboxCredentialStrategy.workloadIdentity('aud'));
  });

  it('defaults the user identity scopes and header', () => {
    expect(
      ToolboxCredentialStrategy.userIdentity({
        clientId: 'client',
        clientSecret: 'secret',
      }),
    ).toEqual({
      type: ToolboxCredentialType.USER_IDENTITY,
      clientId: 'client',
      clientSecret: 'secret',
      scopes: ['openid', 'profile', 'email'],
      headerName: 'Authorization',
    });
  });

  it('keeps the user identity scopes and header it is given', () => {
    expect(
      ToolboxCredentialStrategy.userIdentity({
        clientId: 'client',
        clientSecret: 'secret',
        scopes: ['https://www.googleapis.com/auth/bigquery'],
        headerName: 'X-User-Token',
      }),
    ).toMatchObject({
      scopes: ['https://www.googleapis.com/auth/bigquery'],
      headerName: 'X-User-Token',
    });
  });

  it('defaults the manual token scheme to Bearer', () => {
    expect(ToolboxCredentialStrategy.manualToken('tok')).toEqual({
      type: ToolboxCredentialType.MANUAL_TOKEN,
      token: 'tok',
      scheme: 'Bearer',
    });
  });

  it('keeps a manual token scheme it is given', () => {
    expect(ToolboxCredentialStrategy.manualToken('tok', 'Token')).toMatchObject(
      {scheme: 'Token'},
    );
  });

  it('carries the token source of manual credentials', () => {
    const credentials = {getAccessToken: async () => ({token: 'from-source'})};

    expect(ToolboxCredentialStrategy.manualCredentials(credentials)).toEqual({
      type: ToolboxCredentialType.MANUAL_CREDS,
      credentials,
    });
  });

  it('defaults the api key header to X-API-Key', () => {
    expect(ToolboxCredentialStrategy.apiKey('key')).toEqual({
      type: ToolboxCredentialType.API_KEY,
      apiKey: 'key',
      headerName: 'X-API-Key',
    });
  });

  it('keeps an api key header it is given', () => {
    expect(ToolboxCredentialStrategy.apiKey('key', 'X-Custom')).toMatchObject({
      headerName: 'X-Custom',
    });
  });
});

describe('credentialClientHeaders', () => {
  it('sends nothing for a toolbox identity', () => {
    expect(
      credentialClientHeaders(
        ToolboxCredentialStrategy.toolboxIdentity(),
        NO_USER_TOKEN,
      ),
    ).toEqual({});
  });

  it('sends a minted id token for a workload identity', async () => {
    expect(
      await singleHeader(ToolboxCredentialStrategy.workloadIdentity('aud')),
    ).toEqual(['Authorization', 'Bearer id-token']);
  });

  it('falls back to the default access token when no id token is minted', async () => {
    auth.idTokenError = new Error('no metadata server');

    expect(
      await singleHeader(ToolboxCredentialStrategy.workloadIdentity('aud')),
    ).toEqual(['Authorization', 'Bearer access-token']);
  });

  it('sends nothing when neither an id token nor an access token exists', async () => {
    auth.idTokenError = new Error('no metadata server');
    auth.accessToken = null;

    expect(
      await singleHeader(ToolboxCredentialStrategy.workloadIdentity('aud')),
    ).toEqual(['Authorization', '']);
  });

  it('resolves the workload identity token per request', async () => {
    const headers = credentialClientHeaders(
      ToolboxCredentialStrategy.workloadIdentity('aud'),
      NO_USER_TOKEN,
    );
    auth.idToken = 'first';
    const first = await resolve(headers['Authorization']);
    auth.idToken = 'second';
    const second = await resolve(headers['Authorization']);

    expect([first, second]).toEqual(['Bearer first', 'Bearer second']);
  });

  it('sends a manual token with its scheme', async () => {
    expect(
      await singleHeader(ToolboxCredentialStrategy.manualToken('tok')),
    ).toEqual(['Authorization', 'Bearer tok']);
    expect(
      await singleHeader(ToolboxCredentialStrategy.manualToken('tok', 'Token')),
    ).toEqual(['Authorization', 'Token tok']);
  });

  it('defaults a manual token with no scheme to Bearer', async () => {
    expect(
      await singleHeader({
        type: ToolboxCredentialType.MANUAL_TOKEN,
        token: 'tok',
      }),
    ).toEqual(['Authorization', 'Bearer tok']);
  });

  it('sends the access token of a manual credentials source', async () => {
    expect(
      await singleHeader(
        ToolboxCredentialStrategy.manualCredentials({
          getAccessToken: async () => ({token: 'from-source'}),
        }),
      ),
    ).toEqual(['Authorization', 'Bearer from-source']);
  });

  it('sends nothing when the manual credentials source has no token', async () => {
    expect(
      await singleHeader(
        ToolboxCredentialStrategy.manualCredentials({
          getAccessToken: async () => ({token: null}),
        }),
      ),
    ).toEqual(['Authorization', '']);
  });

  it('sends an api key in its header', async () => {
    expect(await singleHeader(ToolboxCredentialStrategy.apiKey('key'))).toEqual(
      ['X-API-Key', 'key'],
    );
    expect(
      await singleHeader(ToolboxCredentialStrategy.apiKey('key', 'X-Custom')),
    ).toEqual(['X-Custom', 'key']);
  });

  it('sends the user token of the invocation in progress', async () => {
    expect(
      await singleHeader(
        ToolboxCredentialStrategy.userIdentity({
          clientId: 'client',
          clientSecret: 'secret',
        }),
        () => 'user-token',
      ),
    ).toEqual(['Authorization', 'Bearer user-token']);
  });

  it('sends an empty user token when no invocation is in scope', async () => {
    expect(
      await singleHeader(
        ToolboxCredentialStrategy.userIdentity({
          clientId: 'client',
          clientSecret: 'secret',
          headerName: 'X-User-Token',
        }),
      ),
    ).toEqual(['X-User-Token', '']);
  });

  it('rejects a workload identity with no target audience', () => {
    expect(() =>
      credentialClientHeaders(
        {type: ToolboxCredentialType.WORKLOAD_IDENTITY},
        NO_USER_TOKEN,
      ),
    ).toThrow('targetAudience is required for WORKLOAD_IDENTITY');
  });

  it('rejects a manual token with no token', () => {
    expect(() =>
      credentialClientHeaders(
        {type: ToolboxCredentialType.MANUAL_TOKEN},
        NO_USER_TOKEN,
      ),
    ).toThrow('token is required for MANUAL_TOKEN');
  });

  it('rejects manual credentials with no source', () => {
    expect(() =>
      credentialClientHeaders(
        {type: ToolboxCredentialType.MANUAL_CREDS},
        NO_USER_TOKEN,
      ),
    ).toThrow('credentials object is required for MANUAL_CREDS');
  });

  it('rejects an api key with no key and an api key with no header', () => {
    expect(() =>
      credentialClientHeaders(
        {type: ToolboxCredentialType.API_KEY, headerName: 'X-API-Key'},
        NO_USER_TOKEN,
      ),
    ).toThrow('apiKey and headerName are required for API_KEY');
    expect(() =>
      credentialClientHeaders(
        {type: ToolboxCredentialType.API_KEY, apiKey: 'key'},
        NO_USER_TOKEN,
      ),
    ).toThrow('apiKey and headerName are required for API_KEY');
  });
});

describe('userIdentityAuthConfig', () => {
  it('asks Google for an authorization code over the configured scopes', () => {
    expect(
      userIdentityAuthConfig(
        ToolboxCredentialStrategy.userIdentity({
          clientId: 'client',
          clientSecret: 'secret',
          scopes: ['https://www.googleapis.com/auth/bigquery'],
        }),
        'toolbox_user_identity_http://127.0.0.1:5000',
      ),
    ).toEqual({
      authScheme: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: {'https://www.googleapis.com/auth/bigquery': ''},
          },
        },
      },
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client', clientSecret: 'secret'},
      },
      credentialKey: 'toolbox_user_identity_http://127.0.0.1:5000',
    });
  });

  it('falls back to the default scopes when the list is empty', () => {
    const config = userIdentityAuthConfig(
      {
        type: ToolboxCredentialType.USER_IDENTITY,
        clientId: 'client',
        clientSecret: 'secret',
        scopes: [],
      },
      'key',
    );

    expect(config.authScheme).toMatchObject({
      flows: {
        authorizationCode: {scopes: {openid: '', profile: '', email: ''}},
      },
    });
  });

  it('rejects a user identity with no client id or no client secret', () => {
    expect(() =>
      userIdentityAuthConfig(
        {type: ToolboxCredentialType.USER_IDENTITY, clientSecret: 'secret'},
        'key',
      ),
    ).toThrow('USER_IDENTITY requires clientId and clientSecret');
    expect(() =>
      userIdentityAuthConfig(
        {type: ToolboxCredentialType.USER_IDENTITY, clientId: 'client'},
        'key',
      ),
    ).toThrow('USER_IDENTITY requires clientId and clientSecret');
  });
});

describe('ToolboxCredentialStrategy.fromAdkCredentials', () => {
  it('turns an OAuth2 credential into a user identity', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client', clientSecret: 'secret'},
    };

    expect(ToolboxCredentialStrategy.fromAdkCredentials(credential)).toEqual({
      type: ToolboxCredentialType.USER_IDENTITY,
      clientId: 'client',
      clientSecret: 'secret',
      scopes: ['openid', 'profile', 'email'],
      headerName: 'Authorization',
    });
  });

  it('reads an OAuth2 credential that carries no client fields as empty', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {},
    };

    expect(
      ToolboxCredentialStrategy.fromAdkCredentials(credential),
    ).toMatchObject({clientId: '', clientSecret: ''});
  });

  it('turns an HTTP bearer credential into a manual token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token: 'tok'}},
    };

    expect(ToolboxCredentialStrategy.fromAdkCredentials(credential)).toEqual({
      type: ToolboxCredentialType.MANUAL_TOKEN,
      token: 'tok',
      scheme: 'Bearer',
    });
  });

  it('rejects an HTTP scheme that is not bearer', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'basic', credentials: {username: 'u', password: 'p'}},
    };

    expect(() =>
      ToolboxCredentialStrategy.fromAdkCredentials(credential),
    ).toThrow('Unsupported HTTP authentication scheme: basic');
  });

  it('rejects an HTTP credential with no scheme', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: '', credentials: {token: 'tok'}},
    };

    expect(() =>
      ToolboxCredentialStrategy.fromAdkCredentials(credential),
    ).toThrow('Unsupported HTTP authentication scheme: ');
  });

  it('rejects an HTTP bearer credential with no token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {}},
    };

    expect(() =>
      ToolboxCredentialStrategy.fromAdkCredentials(credential),
    ).toThrow('Unsupported HTTP authentication scheme: bearer');
  });

  it('turns an API key credential into an api key on the scheme header', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key',
    };
    const scheme: AuthScheme = {type: 'apiKey', name: 'X-Custom', in: 'header'};

    expect(
      ToolboxCredentialStrategy.fromAdkCredentials(credential, scheme),
    ).toEqual({
      type: ToolboxCredentialType.API_KEY,
      apiKey: 'key',
      headerName: 'X-Custom',
    });
  });

  it('rejects an API key credential with no scheme', () => {
    expect(() =>
      ToolboxCredentialStrategy.fromAdkCredentials({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    ).toThrow('API Key credentials require the authScheme definition.');
  });

  it('rejects an API key scheme with no header name', () => {
    const scheme: AuthScheme = {type: 'http', scheme: 'bearer'};

    expect(() =>
      ToolboxCredentialStrategy.fromAdkCredentials(
        {authType: AuthCredentialTypes.API_KEY, apiKey: 'key'},
        scheme,
      ),
    ).toThrow('API Key scheme must define the header name.');
  });

  it('rejects an API key the scheme sends outside the header', () => {
    const scheme: AuthScheme = {type: 'apiKey', name: 'token', in: 'query'};

    expect(() =>
      ToolboxCredentialStrategy.fromAdkCredentials(
        {authType: AuthCredentialTypes.API_KEY, apiKey: 'key'},
        scheme,
      ),
    ).toThrow(
      "Unsupported API Key location: query. Only 'header' is supported.",
    );
  });

  it('rejects a credential type the Toolbox client cannot send', () => {
    expect(() =>
      ToolboxCredentialStrategy.fromAdkCredentials({
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      }),
    ).toThrow('Unsupported ADK credential type: serviceAccount');
  });
});

describe('ToolboxCredentialStrategy.fromAdkAuthConfig', () => {
  it('converts the raw credential with the config scheme', () => {
    expect(
      ToolboxCredentialStrategy.fromAdkAuthConfig({
        authScheme: {type: 'apiKey', name: 'X-Custom', in: 'header'},
        rawAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'key',
        },
        credentialKey: 'key',
      }),
    ).toEqual({
      type: ToolboxCredentialType.API_KEY,
      apiKey: 'key',
      headerName: 'X-Custom',
    });
  });

  it('rejects a config with no raw credential', () => {
    expect(() =>
      ToolboxCredentialStrategy.fromAdkAuthConfig({
        authScheme: {type: 'http', scheme: 'bearer'},
        credentialKey: 'key',
      }),
    ).toThrow('AuthConfig must have a rawAuthCredential.');
  });
});
