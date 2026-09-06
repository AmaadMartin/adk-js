/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthHandler,
  State,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import * as oauth2Utils from '../../src/auth/oauth2/oauth2_utils.js';

// Only the network call is stubbed, so the real OAuth2CredentialExchanger runs.
vi.mock('../../src/auth/oauth2/oauth2_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof oauth2Utils>()),
  fetchOAuth2Tokens: vi.fn(),
}));

const CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
};

describe('AuthHandler when the token endpoint fails', () => {
  beforeEach(() => {
    vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
      new Error('Token request failed with status 503'),
    );
  });

  it('stores the unexchanged credential for an oauth2 scheme', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'testKey',
      authScheme: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/auth',
            tokenUrl: 'https://example.com/token',
            scopes: {},
          },
        },
      },
      exchangedAuthCredential: CREDENTIAL,
    };
    const handler = new AuthHandler(authConfig);
    const state = new State();

    await expect(
      handler.parseAndStoreAuthResponse(state),
    ).resolves.toBeUndefined();

    expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalled();
    expect(state.get('temp:testKey')).toBe(CREDENTIAL);
    expect(
      state.get<AuthCredential>('temp:testKey')?.oauth2?.accessToken,
    ).toBeUndefined();
  });

  it('stores the unexchanged credential for an openIdConnect scheme', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'testKey',
      authScheme: {
        type: 'openIdConnect',
        openIdConnectUrl:
          'https://example.com/.well-known/openid-configuration',
        authorizationEndpoint: 'https://example.com/auth',
        tokenEndpoint: 'https://example.com/token',
        grantTypesSupported: ['authorization_code'],
      },
      exchangedAuthCredential: CREDENTIAL,
    };
    const handler = new AuthHandler(authConfig);
    const state = new State();

    await expect(
      handler.parseAndStoreAuthResponse(state),
    ).resolves.toBeUndefined();

    expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalled();
    expect(state.get('temp:testKey')).toBe(CREDENTIAL);
    expect(
      state.get<AuthCredential>('temp:testKey')?.oauth2?.accessToken,
    ).toBeUndefined();
  });
});
