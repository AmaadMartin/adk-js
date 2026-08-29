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
  ToolAuthHandler,
  ToolContextCredentialStore,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {State} from '../../../src/sessions/state.js';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';

/** An exchanger that returns the credential it was given, as the real one
 * does for a credential type it has no exchanger for. */
function passThroughExchanger() {
  return {
    exchange: vi
      .fn()
      .mockImplementation(
        async ({authCredential}: {authCredential: AuthCredential}) => ({
          credential: authCredential,
          wasExchanged: false,
        }),
      ),
  };
}

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
    // A cached credential is handed back to the exchanger, which has nothing
    // registered for an http credential and returns it unchanged.
    vi.mocked(AutoAuthCredentialExchanger).mockImplementationOnce(
      () => passThroughExchanger() as unknown as AutoAuthCredentialExchanger,
    );
    const scheme: AuthScheme = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const state = new State();
    const mockContext = {state} as unknown as Context;
    // Derive the key instead of hardcoding it, so this pins the caching
    // behaviour rather than the key format.
    const key = await new ToolContextCredentialStore(
      mockContext,
    ).getCredentialKey(scheme);
    state.set(key, {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'cached-token'}},
    });

    const handler = new ToolAuthHandler(mockContext, scheme);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe('cached-token');
  });

  it('should store the auth response credential in state and record it in the delta', async () => {
    const scheme: AuthScheme = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key',
      }),
    } as unknown as Context;

    const handler = new ToolAuthHandler(mockContext, scheme);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    // Stored via the State API so it is readable back through State.get...
    const key = await new ToolContextCredentialStore(
      mockContext,
    ).getCredentialKey(scheme);
    expect(state.get<AuthCredential>(key)?.apiKey).toBe('key');
    // ...and recorded in the delta so it is persisted to the session (rather
    // than being re-requested on every subsequent tool call).
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
    const scheme: AuthScheme = {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      },
    };
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };
    const state = new State();
    const mockContext = {
      state,
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await new ToolAuthHandler(
      mockContext,
      scheme,
      credential,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    // An exchange costs a round trip, so its result is worth persisting.
    const stored = state.get<{http?: {credentials: {token: string}}}>(
      await new ToolContextCredentialStore(mockContext).getCredentialKey(
        scheme,
        credential,
      ),
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
  });
});
