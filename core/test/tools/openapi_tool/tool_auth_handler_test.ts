/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BaseCredentialExchanger,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  State,
  ToolAuthHandler,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const exchange = vi.hoisted(() => vi.fn<BaseCredentialExchanger['exchange']>());

vi.mock(
  '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js',
  () => ({AutoAuthCredentialExchanger: vi.fn(() => ({exchange}))}),
);

const EXCHANGED_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
};

const API_KEY_SCHEME: OpenAPIV3.ApiKeySecurityScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const FUNCTION_CALL_ID = 'fc-1';

/** The key `AuthHandler` reads an interactive auth response from. */
const AUTH_RESPONSE_KEY = `${State.TEMP_PREFIX}default_openapi_key`;

const API_KEY_AUTH_RESPONSE: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'key',
};

function createToolContext(state: Record<string, unknown> = {}): Context {
  const session = createSession({
    id: 'session-id',
    appName: 'app',
    userId: 'user',
    state,
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'openapi_agent'}),
    session,
    pluginManager: new PluginManager([]),
  });

  // requestCredential throws without a functionCallId, so every context gets
  // one: a test that stops requesting a credential fails on its assertion
  // rather than on a fixture error.
  return new Context({invocationContext, functionCallId: FUNCTION_CALL_ID});
}

beforeEach(() => {
  exchange.mockReset();
  exchange.mockResolvedValue({
    credential: EXCHANGED_CREDENTIAL,
    wasExchanged: true,
  });
});

describe('ToolAuthHandler', () => {
  it('should return done if no auth scheme', async () => {
    const handler = new ToolAuthHandler(createToolContext());

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential).toBeUndefined();
  });

  it('should return done after exchange if credential in context', async () => {
    const context = createToolContext({
      [AUTH_RESPONSE_KEY]: API_KEY_AUTH_RESPONSE,
    });

    const handler = new ToolAuthHandler(context, API_KEY_SCHEME);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
  });

  it('should return pending and request credential if not in context', async () => {
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    const handler = new ToolAuthHandler(context, API_KEY_SCHEME);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('pending');
    expect(requestCredential).toHaveBeenCalled();
    // The real method records the request on the event actions, which is what
    // carries it back to the client.
    expect(
      context.actions.requestedAuthConfigs[FUNCTION_CALL_ID],
    ).toBeDefined();
  });

  it('should return cached credential if available', async () => {
    const context = createToolContext({
      apiKey_existing_exchanged_credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'cached-token'}},
      },
    });

    const handler = new ToolAuthHandler(context, API_KEY_SCHEME);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe('cached-token');
  });

  it('should store exchanged credential in state and record it in the delta', async () => {
    const context = createToolContext({
      [AUTH_RESPONSE_KEY]: API_KEY_AUTH_RESPONSE,
    });

    const handler = new ToolAuthHandler(context, API_KEY_SCHEME);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    // Stored via the State API so it is readable back through State.get...
    const stored = context.state.get<{http?: {credentials: {token: string}}}>(
      'apiKey_existing_exchanged_credential',
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
    // ...and recorded in the delta so it is persisted to the session (rather
    // than being re-exchanged on every subsequent tool call).
    expect(context.state.hasDelta()).toBe(true);
    expect(context.actions.stateDelta).toHaveProperty(
      'apiKey_existing_exchanged_credential',
    );
  });

  it('re-uses a credential persisted by a previous tool call instead of re-exchanging', async () => {
    // First invocation: exchange and store the credential.
    const firstContext = createToolContext({
      [AUTH_RESPONSE_KEY]: API_KEY_AUTH_RESPONSE,
    });
    await new ToolAuthHandler(
      firstContext,
      API_KEY_SCHEME,
    ).prepareAuthCredentials();

    // Each tool call gets a fresh Context whose State is rebuilt from the
    // session. The session service commits the event's state delta, so only
    // what State.set recorded survives the round-trip (a stray own-property on
    // the State instance would not).
    const secondContext = createToolContext({
      ...firstContext.actions.stateDelta,
    });
    const getAuthResponse = vi.spyOn(secondContext, 'getAuthResponse');
    const result = await new ToolAuthHandler(
      secondContext,
      API_KEY_SCHEME,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.http?.credentials.token).toBe(
      'exchanged-token',
    );
    // The cached credential was reused; no second exchange was triggered.
    expect(getAuthResponse).not.toHaveBeenCalled();
  });

  it('uses the credential the tool was configured with instead of requesting one', async () => {
    const context = createToolContext();
    const requestCredential = vi.spyOn(context, 'requestCredential');

    const result = await new ToolAuthHandler(context, API_KEY_SCHEME, {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'static-key',
    }).prepareAuthCredentials();

    // Schemes like apiKey need no user interaction, so asking the client for a
    // credential would leave the tool stuck in `pending` forever.
    expect(result.state).toBe('done');
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('does not copy a static credential that needed no exchange into session state', async () => {
    const staticCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'static-key',
    };
    // The real exchanger has no exchanger registered for apiKey/http, so it
    // hands the credential straight back.
    exchange.mockResolvedValueOnce({
      credential: staticCredential,
      wasExchanged: false,
    });

    const context = createToolContext();

    const result = await new ToolAuthHandler(
      context,
      API_KEY_SCHEME,
      staticCredential,
    ).prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential?.apiKey).toBe('static-key');
    // It is readable from the tool on every invocation, so persisting it would
    // only write the secret into the session store for nothing.
    expect(
      context.state.get('apiKey_existing_exchanged_credential'),
    ).toBeUndefined();
    expect(context.state.hasDelta()).toBe(false);
  });

  it('caches a static credential that did require an exchange', async () => {
    const context = createToolContext();

    const result = await new ToolAuthHandler(
      context,
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
    const stored = context.state.get<{http?: {credentials: {token: string}}}>(
      'oauth2_existing_exchanged_credential',
    );
    expect(stored?.http?.credentials.token).toBe('exchanged-token');
  });
});
