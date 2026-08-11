/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ToolAuthHandler,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ExchangeResult} from '../../../src/auth/exchanger/base_credential_exchanger.js';

const exchange = vi.hoisted(() => vi.fn<() => Promise<ExchangeResult>>());

vi.mock(
  '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js',
  () => ({
    AutoAuthCredentialExchanger: vi.fn().mockImplementation(() => ({exchange})),
  }),
);

const OAUTH2_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: {},
    },
  },
};

const API_KEY_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const UNEXCHANGED_OAUTH2_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'key',
};

/**
 * Builds a real Context whose session state already holds the credential that
 * `Context.getAuthResponse()` reads back, which is how a client supplies a
 * credential interactively.
 */
function createContextWithAuthResponse(credential: AuthCredential): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        state: {'temp:default_openapi_key': credential},
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('ToolAuthHandler with a degraded exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not cache an OAuth2 credential whose exchange failed', async () => {
    exchange.mockResolvedValue({
      credential: UNEXCHANGED_OAUTH2_CREDENTIAL,
      wasExchanged: false,
    });
    const context = createContextWithAuthResponse(
      UNEXCHANGED_OAUTH2_CREDENTIAL,
    );
    const handler = new ToolAuthHandler(context, OAUTH2_SCHEME);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(result.authCredential).toBe(UNEXCHANGED_OAUTH2_CREDENTIAL);
    expect(
      context.state.get('oauth2_existing_exchanged_credential'),
    ).toBeUndefined();
    expect(context.state.hasDelta()).toBe(false);
  });

  it('caches an auth response credential that needs no external exchange', async () => {
    exchange.mockResolvedValue({
      credential: API_KEY_CREDENTIAL,
      wasExchanged: false,
    });
    const context = createContextWithAuthResponse(API_KEY_CREDENTIAL);
    const handler = new ToolAuthHandler(context, API_KEY_SCHEME);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(context.state.get('apiKey_existing_exchanged_credential')).toBe(
      API_KEY_CREDENTIAL,
    );
    expect(context.state.hasDelta()).toBe(true);
  });

  it('caches an OAuth2 credential that was exchanged', async () => {
    const exchanged: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {...UNEXCHANGED_OAUTH2_CREDENTIAL.oauth2, accessToken: 'token'},
    };
    exchange.mockResolvedValue({credential: exchanged, wasExchanged: true});
    const context = createContextWithAuthResponse(
      UNEXCHANGED_OAUTH2_CREDENTIAL,
    );
    const handler = new ToolAuthHandler(context, OAUTH2_SCHEME);

    const result = await handler.prepareAuthCredentials();

    expect(result.state).toBe('done');
    expect(context.state.get('oauth2_existing_exchanged_credential')).toBe(
      exchanged,
    );
    expect(context.state.hasDelta()).toBe(true);
  });
});
