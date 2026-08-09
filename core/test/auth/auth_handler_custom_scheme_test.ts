/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredentialTypes,
  AuthHandler,
  CustomAuthScheme,
  State,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const exchange = vi.fn();

vi.mock('../../src/auth/oauth2/oauth2_credential_exchanger.js', () => ({
  OAuth2CredentialExchanger: class {
    exchange = exchange;
  },
}));

interface AcmeVaultScheme extends CustomAuthScheme {
  type: 'acmeVault';
  vaultPath: string;
}

const ACME_VAULT_SCHEME: AcmeVaultScheme = {
  type: 'acmeVault',
  vaultPath: 'secret/acme',
};

describe('AuthHandler with a custom auth scheme', () => {
  beforeEach(() => {
    exchange.mockReset();
  });

  it('stores the exchanged credential as-is and runs no OAuth2 exchange', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'testKey',
      authScheme: ACME_VAULT_SCHEME,
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'acmeToken',
      },
    };
    const handler = new AuthHandler(authConfig);
    const state = new State();

    await handler.parseAndStoreAuthResponse(state);

    expect(state.get('temp:testKey')).toEqual({
      authType: 'apiKey',
      apiKey: 'acmeToken',
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('returns the auth request unchanged', () => {
    const authConfig: AuthConfig = {
      credentialKey: 'testKey',
      authScheme: ACME_VAULT_SCHEME,
    };
    const handler = new AuthHandler(authConfig);

    expect(handler.generateAuthRequest()).toBe(authConfig);
  });

  it('throws when generateAuthUri finds no authorization endpoint', () => {
    const authConfig: AuthConfig = {
      credentialKey: 'testKey',
      authScheme: ACME_VAULT_SCHEME,
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
