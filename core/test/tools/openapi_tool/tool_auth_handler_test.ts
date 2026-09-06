/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Context,
  ExtendedOAuth2,
  OAuth2DiscoveryManager,
  ToolAuthHandler,
} from '@google/adk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {State} from '../../../src/sessions/state.js';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';

// Mock AutoAuthCredentialExchanger
vi.mock(
  '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js',
  () => {
    return {
      AutoAuthCredentialExchanger: vi.fn().mockImplementation(() => ({
        exchange: vi.fn().mockResolvedValue({
          credential: {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
          },
          wasExchanged: true,
        }),
      })),
    };
  },
);

describe('ToolAuthHandler', () => {
  it('should return done if no auth scheme', async () => {
    const mockContext = {} as unknown as Context;
    const handler = new ToolAuthHandler(mockContext);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential).toBeUndefined();
  });

  it('should return done after exchange if credential in context', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
  });

  it('should return pending and request credential if not in context', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(mockContext.requestCredential).toHaveBeenCalled();
  });

  it('should return cached credential if available', async () => {
    const mockContext = {
      state: new State({
        'apiKey_existing_exchanged_credential': {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'cached-token'}},
        },
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe('cached-token');
  });

  it('should store exchanged credential in state and record it in the delta', async () => {
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    // Stored via the State API so it is readable back through State.get...
    const stored = state.get<{http?: {credentials: {token: string}}}>(
      'apiKey_existing_exchanged_credential',
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
    // ...and recorded in the delta so it is persisted to the session (rather
    // than being re-exchanged on every subsequent tool call).
    expect(state.hasDelta()).toBe(true);
  });

  it('re-uses a credential persisted by a previous tool call instead of re-exchanging', async () => {
    // First invocation: exchange and store the credential.
    const firstState = new State();
    const firstContext = {
      state: firstState,
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;
    await new ToolAuthHandler(firstContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    }).prepareAuthCredentials();

    // Each tool call gets a fresh Context whose State is rebuilt from the
    // values persisted to the session. Only what was recorded in the state
    // delta/value survives this round-trip (a stray own-property would not).
    const secondState = new State(firstState.toRecord());
    const secondContext = {
      state: secondState,
      getAuthResponse: vi.fn(),
    } as unknown as Context;
    const result = await new ToolAuthHandler(secondContext, {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    }).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
    // The cached credential was reused; no second exchange was triggered.
    expect(secondContext.getAuthResponse).not.toHaveBeenCalled();
  });

  it('uses the credential the tool was configured with instead of requesting one', async () => {
    const mockContext = {
      state: new State(),
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      {authType: AuthCredentialTypes.API_KEY, apiKey: 'static-key'},
    ).prepareAuthCredentials();

    // Schemes like apiKey need no user interaction, so asking the client for a
    // credential would leave the tool stuck in `pending` forever.
    expect(result.state).toBe('done');
    expect(mockContext.requestCredential).not.toHaveBeenCalled();
  });

  it('does not copy a static credential that needed no exchange into session state', async () => {
    const staticCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'static-key',
    };
    // The real exchanger has no exchanger registered for apiKey/http, so it
    // hands the credential straight back.
    vi.mocked(AutoAuthCredentialExchanger).mockImplementationOnce(
      () =>
        ({
          exchange: vi.fn().mockResolvedValue({
            credential: staticCredential,
            wasExchanged: false,
          }),
        }) as unknown as AutoAuthCredentialExchanger,
    );

    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      staticCredential,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.apiKey).toBe('static-key');
    // It is readable from the tool on every invocation, so persisting it would
    // only write the secret into the session store for nothing.
    expect(state.get('apiKey_existing_exchanged_credential')).toBeUndefined();
    expect(state.hasDelta()).toBe(false);
  });

  it('caches a static credential that did require an exchange', async () => {
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://example.com/token',
            scopes: {},
          },
        },
      },
      {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
      },
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    // An exchange costs a round trip, so its result is worth persisting.
    const stored = state.get<{http?: {credentials: {token: string}}}>(
      'oauth2_existing_exchanged_credential',
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
  });

  describe('ExtendedOAuth2 endpoint discovery', () => {
    const OAUTH2_CREDENTIAL: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };

    let discoverSpy: MockInstance<
      OAuth2DiscoveryManager['discoverAuthServerMetadata']
    >;

    const newContext = () =>
      ({
        state: new State(),
        getAuthResponse: vi.fn().mockReturnValue(undefined),
        requestCredential: vi.fn(),
      }) as unknown as Context;

    beforeEach(() => {
      discoverSpy = vi
        .spyOn(OAuth2DiscoveryManager.prototype, 'discoverAuthServerMetadata')
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      discoverSpy.mockRestore();
    });

    it('fills a blank tokenUrl from the issuer before the credential is exchanged', async () => {
      discoverSpy.mockResolvedValue({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      });
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: 'https://auth.example.com',
        flows: {clientCredentials: {tokenUrl: '', scopes: {}}},
      };
      const mockContext = newContext();

      const result = await new ToolAuthHandler(
        mockContext,
        scheme,
        OAUTH2_CREDENTIAL,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(discoverSpy).toHaveBeenCalledExactlyOnceWith(
        'https://auth.example.com',
      );
      expect(scheme.flows.clientCredentials?.tokenUrl).toBe(
        'https://auth.example.com/token',
      );
    });

    it('does not discover when the scheme already names its endpoints', async () => {
      const mockContext = newContext();

      const result = await new ToolAuthHandler(
        mockContext,
        {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://example.com/token',
              scopes: {},
            },
          },
        },
        OAUTH2_CREDENTIAL,
      ).prepareAuthCredentials();

      expect(result.state).toBe('done');
      expect(discoverSpy).not.toHaveBeenCalled();
    });

    it('does not discover again once the issuer has filled the endpoints', async () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: 'https://auth.example.com',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://auth.example.com/token',
            scopes: {},
          },
        },
      };
      const mockContext = newContext();

      const result = await new ToolAuthHandler(
        mockContext,
        scheme,
        OAUTH2_CREDENTIAL,
      ).prepareAuthCredentials();

      // The handler holds the scheme the tool was built with, so a filled
      // scheme costs no further round trip on later invocations.
      expect(result.state).toBe('done');
      expect(discoverSpy).not.toHaveBeenCalled();
    });

    it('still prepares the credential when discovery finds no metadata', async () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: 'https://auth.example.com',
        flows: {clientCredentials: {tokenUrl: '', scopes: {}}},
      };
      const mockContext = newContext();

      const result = await new ToolAuthHandler(
        mockContext,
        scheme,
        OAUTH2_CREDENTIAL,
      ).prepareAuthCredentials();

      // A failed discovery degrades to the behaviour the handler had before
      // the scheme named an issuer.
      expect(result.state).toBe('done');
      expect(result.authCredential?.http?.credentials.token).toBe(
        'exchanged-token',
      );
      expect(scheme.flows.clientCredentials?.tokenUrl).toBe('');
    });

    it('does not discover when a cached credential answers the call', async () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: 'https://auth.example.com',
        flows: {clientCredentials: {tokenUrl: '', scopes: {}}},
      };
      const mockContext = {
        state: new State({
          'oauth2_existing_exchanged_credential': {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', credentials: {token: 'cached-token'}},
          },
        }),
      } as unknown as Context;

      const result = await new ToolAuthHandler(
        mockContext,
        scheme,
        OAUTH2_CREDENTIAL,
      ).prepareAuthCredentials();

      expect(result.authCredential?.http?.credentials.token).toBe(
        'cached-token',
      );
      expect(discoverSpy).not.toHaveBeenCalled();
    });

    it('asks for a credential when an OAuth2 scheme declares no flows', async () => {
      // A scheme parsed out of an OpenAPI document is cast, not validated, so
      // `flows` can be missing however the type declares it.
      const scheme = {type: 'oauth2'} as AuthScheme;
      const mockContext = newContext();

      const result = await new ToolAuthHandler(
        mockContext,
        scheme,
      ).prepareAuthCredentials();

      expect(result.state).toBe('pending');
      expect(mockContext.requestCredential).toHaveBeenCalled();
      expect(discoverSpy).not.toHaveBeenCalled();
    });
  });
});
