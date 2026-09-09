/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthConfig, AuthCredentialTypes, AuthHandler, State} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

vi.mock('../../src/auth/oauth2/oauth2_credential_exchanger.js', () => ({
  OAuth2CredentialExchanger: class {
    exchange = vi.fn().mockResolvedValue({
      credential: {
        authType: 'oauth2',
        oauth2: {accessToken: 'mockAccessToken'},
      },
      wasExchanged: true,
    });
  },
}));

describe('AuthHandler', () => {
  describe('getAuthResponse', () => {
    it('returns credential from state when temp:key is present', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
      };
      const handler = new AuthHandler(authConfig);
      const state = new State({
        'temp:testKey': {authType: 'apiKey', apiKey: 'testToken'},
      });

      const response = handler.getAuthResponse(state);

      expect(response).toEqual({
        authType: 'apiKey',
        apiKey: 'testToken',
      });
    });

    it('returns undefined when temp:key is not present', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
      };
      const handler = new AuthHandler(authConfig);
      const state = new State();

      const response = handler.getAuthResponse(state);

      expect(response).toBeUndefined();
    });
  });

  describe('parseAndStoreAuthResponse', () => {
    it('stores exchangedAuthCredential when present for non-oauth2', async () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'testToken',
        },
      };
      const handler = new AuthHandler(authConfig);
      const state = new State();

      await handler.parseAndStoreAuthResponse(state);

      expect(state.get('temp:testKey')).toEqual({
        authType: 'apiKey',
        apiKey: 'testToken',
      });
    });

    it('returns early if scheme type is not oauth2 or openIdConnect', async () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
      };
      const handler = new AuthHandler(authConfig);
      const state = new State();

      await handler.parseAndStoreAuthResponse(state);

      expect(state.get('temp:testKey')).toBeUndefined();
    });

    it('stores exchangedCredential.credential for oauth2 when exchange happens', async () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {authCode: '123'},
        },
      };
      const handler = new AuthHandler(authConfig);
      const state = new State();

      await handler.parseAndStoreAuthResponse(state);

      expect(state.get('temp:testKey')).toEqual({
        authType: 'oauth2',
        oauth2: {accessToken: 'mockAccessToken'},
      });
    });

    it('throws when credentialKey is an empty string', async () => {
      const authConfig: AuthConfig = {
        credentialKey: '',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'testToken',
        },
      };
      const handler = new AuthHandler(authConfig);
      const state = new State();

      await expect(handler.parseAndStoreAuthResponse(state)).rejects.toThrow(
        'credentialKey is empty.',
      );
      expect(state.get('temp:')).toBeUndefined();
      expect(state.hasDelta()).toBe(false);
    });

    it('throws when an untyped config omits credentialKey', async () => {
      // Mirrors the unchecked cast of client-supplied args in
      // auth_preprocessor.
      const authConfig = {
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'testToken',
        },
      } as AuthConfig;
      const handler = new AuthHandler(authConfig);
      const state = new State();

      await expect(handler.parseAndStoreAuthResponse(state)).rejects.toThrow(
        'credentialKey is empty.',
      );
      expect(state.get('temp:undefined')).toBeUndefined();
      expect(state.hasDelta()).toBe(false);
    });

    it('throws before exchanging an oauth2 credential', async () => {
      const authConfig: AuthConfig = {
        credentialKey: '',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {authCode: '123'},
        },
      };
      const handler = new AuthHandler(authConfig);
      const state = new State();

      await expect(handler.parseAndStoreAuthResponse(state)).rejects.toThrow(
        'credentialKey is empty.',
      );
      expect(state.hasDelta()).toBe(false);
    });
  });

  describe('generateAuthRequest', () => {
    it('returns original config if scheme type is not oauth2 or openIdConnect', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
      };
      const handler = new AuthHandler(authConfig);

      const request = handler.generateAuthRequest();

      expect(request).toBe(authConfig);
    });

    it('returns original config if exchangedAuthCredential.oauth2.authUri is present', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {authUri: 'https://auth.com'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const request = handler.generateAuthRequest();

      expect(request).toBe(authConfig);
    });

    it('throws if rawAuthCredential is missing for oauth2', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthRequest()).toThrow(
        'Auth Scheme oauth2 requires authCredential.',
      );
    });

    it('throws if rawAuthCredential.oauth2 is missing', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'testToken',
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthRequest()).toThrow(
        'Auth Scheme oauth2 requires oauth2 in authCredential.',
      );
    });

    it('returns updated config if rawAuthCredential.oauth2.authUri is present', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {authUri: 'https://auth.com'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const request = handler.generateAuthRequest();

      expect(request.exchangedAuthCredential).toBe(
        authConfig.rawAuthCredential,
      );
    });

    it('throws if clientId or clientSecret are missing', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthRequest()).toThrow(
        'Auth Scheme oauth2 requires both clientId and clientSecret in authCredential.oauth2.',
      );
    });

    it('returns config with exchangedAuthCredential set to generated auth URI', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id', clientSecret: 'secret'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const request = handler.generateAuthRequest();

      expect(request.exchangedAuthCredential).toBeDefined();
      expect(request.exchangedAuthCredential?.oauth2?.authUri).toContain(
        'https://auth.com',
      );
    });
  });

  describe('generateAuthUri', () => {
    it('generates auth URI for oauth2 scheme with flows', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {scope1: 'desc'},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: 'id',
            clientSecret: 'secret',
            redirectUri: 'https://redirect.com',
          },
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri).toBeDefined();
      expect(uri?.oauth2?.authUri).toContain('https://auth.com');
      expect(uri?.oauth2?.authUri).toContain('client_id=id');
      expect(uri?.oauth2?.authUri).toContain(
        'redirect_uri=https%3A%2F%2Fredirect.com',
      );
      expect(uri?.oauth2?.authUri).toContain('scope=scope1');
      expect(uri?.oauth2?.authUri).not.toContain('secret');
      expect(uri?.oauth2?.state).toBeDefined();
    });

    it('throws if authorization endpoint is missing', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: '',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthUri()).toThrow(
        'Authorization endpoint not configured in auth scheme.',
      );
    });

    it('generates auth URI for scheme with authorizationEndpoint (OpenIdConnect)', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'openIdConnect',
          authorizationEndpoint: 'https://oidc-auth.com',
          scopes: ['openid'],
          tokenEndpoint: '',
          openIdConnectUrl: 'https://oidc-auth.com',
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id', redirectUri: 'https://redirect.com'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri).toBeDefined();
      expect(uri?.oauth2?.authUri).toContain('https://oidc-auth.com');
    });

    it('returns original credential if rawAuthCredential or oauth2 is missing', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {type: 'oauth2', flows: {}},
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri).toBeUndefined();
    });

    it('uses tokenUrl as fallback for authorizationEndpoint if authorizationUrl is missing', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri).toBeDefined();
      expect(uri?.oauth2?.authUri).toContain('https://token.com');
    });

    it('takes the endpoint from a later flow when the implicit flow declares a blank authorizationUrl', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            implicit: {authorizationUrl: '', scopes: {read: 'Read access'}},
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {write: 'Write access'},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: 'id',
            clientSecret: 'secret',
            redirectUri: 'https://redirect.com',
          },
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri?.oauth2?.authUri).toContain('https://auth.com');
    });

    it('takes the scopes from the first declared flow, not from the flow that supplied the endpoint', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            implicit: {authorizationUrl: '', scopes: {read: 'Read access'}},
            authorizationCode: {
              authorizationUrl: 'https://auth.com',
              tokenUrl: 'https://token.com',
              scopes: {write: 'Write access'},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {
            clientId: 'id',
            clientSecret: 'secret',
            redirectUri: 'https://redirect.com',
          },
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri?.oauth2?.authUri).toContain('scope=read');
      expect(uri?.oauth2?.authUri).not.toContain('write');
    });

    it('falls through a blank implicit flow to the clientCredentials tokenUrl', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            implicit: {authorizationUrl: '', scopes: {}},
            clientCredentials: {tokenUrl: 'https://cc-token.com', scopes: {}},
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri?.oauth2?.authUri).toContain('https://cc-token.com');
      expect(uri?.oauth2?.authUri).toContain('scope=&');
    });

    it('falls through a blank implicit flow to the password tokenUrl', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            implicit: {authorizationUrl: '', scopes: {}},
            password: {tokenUrl: 'https://pw-token.com', scopes: {}},
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri?.oauth2?.authUri).toContain('https://pw-token.com');
    });

    it('resolves a password-only scheme to its tokenUrl and scopes', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            password: {
              tokenUrl: 'https://pw-token.com',
              scopes: {read: 'Read access'},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri?.oauth2?.authUri).toContain('https://pw-token.com');
      expect(uri?.oauth2?.authUri).toContain('scope=read');
    });

    it('prefers the implicit authorizationUrl over a later flow', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            implicit: {
              authorizationUrl: 'https://implicit.com',
              scopes: {},
            },
            authorizationCode: {
              authorizationUrl: 'https://code.com',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      const uri = handler.generateAuthUri();

      expect(uri?.oauth2?.authUri).toContain('https://implicit.com');
      expect(uri?.oauth2?.authUri).not.toContain('https://code.com');
    });

    it('throws when every declared flow has a blank URL', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            implicit: {authorizationUrl: '', scopes: {}},
            authorizationCode: {
              authorizationUrl: '',
              tokenUrl: '',
              scopes: {},
            },
            clientCredentials: {tokenUrl: '', scopes: {}},
            password: {tokenUrl: '', scopes: {}},
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthUri()).toThrow(
        'Authorization endpoint not configured in auth scheme.',
      );
    });

    it('does not fall back to the authorizationCode tokenUrl as the authorization endpoint', () => {
      const authConfig: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: '',
              tokenUrl: 'https://token.com',
              scopes: {},
            },
          },
        },
        rawAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id'},
        },
      };
      const handler = new AuthHandler(authConfig);

      expect(() => handler.generateAuthUri()).toThrow(
        'Authorization endpoint not configured in auth scheme.',
      );
    });
  });
});
