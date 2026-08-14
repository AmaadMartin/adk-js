/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredentialTypes,
  Context,
  InvocationContext,
  PluginManager,
  SessionStateCredentialService,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const AUTH_CONFIG: AuthConfig = {
  credentialKey: 'roundTripKey',
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

function createContext(state: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 's-1', appName: 'app', state}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('getAuthResponse round trip', () => {
  it('reads back a credential saved by SessionStateCredentialService', async () => {
    const context = createContext();
    const authConfig: AuthConfig = {
      ...AUTH_CONFIG,
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'saved_access_token'},
      },
    };

    await new SessionStateCredentialService().saveCredential(
      authConfig,
      context,
    );

    expect(context.getAuthResponse(authConfig)).toEqual({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'saved_access_token'},
    });
  });

  it('wraps a token an application seeded into the session state', () => {
    const context = createContext({roundTripKey: 'app_supplied_token'});

    expect(context.getAuthResponse(AUTH_CONFIG)).toEqual({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'app_supplied_token'},
    });
  });
});
