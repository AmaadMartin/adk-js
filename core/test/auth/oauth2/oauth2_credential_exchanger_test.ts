/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthScheme,
  CredentialExchangeError,
  OAuth2CredentialExchanger,
  OAuthGrantType,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  determineGrantType,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
} from '../../../src/auth/oauth2/oauth2_credential_exchanger.js';
import * as oauth2Utils from '../../../src/auth/oauth2/oauth2_utils.js';

vi.mock('../../../src/auth/oauth2/oauth2_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof oauth2Utils>()),
  getTokenEndpoint: vi.fn(),
  fetchOAuth2Tokens: vi.fn(),
  parseAuthorizationCode: vi.fn(),
  createOAuth2TokenRequestBody: vi.fn(),
}));

describe('OAuth2CredentialExchanger', () => {
  // Cleared so a guard case can assert that no token request was issued
  // without seeing the calls made by an earlier case.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('exchange', () => {
    it('throws CredentialExchangeError if authScheme is missing', async () => {
      const exchanger = new OAuth2CredentialExchanger();
      const authCredential = {} as AuthCredential;

      await expect(exchanger.exchange({authCredential})).rejects.toThrow(
        CredentialExchangeError,
      );
    });

    it('returns early if accessToken is already present and wasExchanged is false', async () => {
      const exchanger = new OAuth2CredentialExchanger();
      const authCredential = {
        oauth2: {accessToken: 'existing-token'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      const result = await exchanger.exchange({authCredential, authScheme});

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
    });

    it('logs warning and returns if grant type is unsupported', async () => {
      const exchanger = new OAuth2CredentialExchanger();
      const authCredential = {oauth2: {}} as AuthCredential;
      const authScheme = {
        flows: {
          implicit: {}, // Unsupported for exchange by this exchanger usually, if determineGrantType returns undefined
        },
      } as AuthScheme;

      const result = await exchanger.exchange({authCredential, authScheme});

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
    });

    it('delegates to exchangeClientCredentials when grant type is client credentials', async () => {
      const exchanger = new OAuth2CredentialExchanger();
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      } as AuthCredential;
      const authScheme = {
        flows: {
          clientCredentials: {},
        },
      } as AuthScheme;
      const mockTokens = {accessToken: 'new-token'};

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue(mockTokens);

      const result = await exchanger.exchange({authCredential, authScheme});

      expect(result.wasExchanged).toBe(true);
      expect(result.credential.oauth2?.accessToken).toBe('new-token');
    });

    it('delegates to exchangeAuthorizationCode when grant type is authorization code', async () => {
      const exchanger = new OAuth2CredentialExchanger();
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
      } as AuthCredential;
      const authScheme = {
        flows: {
          authorizationCode: {},
        },
      } as AuthScheme;
      const mockTokens = {accessToken: 'new-token'};

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue(mockTokens);

      const result = await exchanger.exchange({authCredential, authScheme});

      expect(result.wasExchanged).toBe(true);
      expect(result.credential.oauth2?.accessToken).toBe('new-token');
    });

    it('returns the unexchanged credential when the delegated authorization code exchange fails', async () => {
      const exchanger = new OAuth2CredentialExchanger();
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
      } as AuthCredential;
      const authScheme = {
        flows: {
          authorizationCode: {},
        },
      } as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        new Error('Service Unavailable'),
      );

      const result = await exchanger.exchange({authCredential, authScheme});

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
    });
  });

  describe('determineGrantType', () => {
    it('returns CLIENT_CREDENTIALS if flows has clientCredentials', () => {
      const authScheme = {
        flows: {
          clientCredentials: {},
        },
      } as AuthScheme;

      expect(determineGrantType(authScheme)).toBe(
        OAuthGrantType.CLIENT_CREDENTIALS,
      );
    });

    it('returns AUTHORIZATION_CODE if flows has authorizationCode', () => {
      const authScheme = {
        flows: {
          authorizationCode: {},
        },
      } as AuthScheme;

      expect(determineGrantType(authScheme)).toBe(
        OAuthGrantType.AUTHORIZATION_CODE,
      );
    });

    it('returns CLIENT_CREDENTIALS for OpenIdConnect with client_credentials in grantTypesSupported', () => {
      const authScheme = {
        grantTypesSupported: ['client_credentials'],
      } as AuthScheme;

      expect(determineGrantType(authScheme)).toBe(
        OAuthGrantType.CLIENT_CREDENTIALS,
      );
    });

    it('returns AUTHORIZATION_CODE for OpenIdConnect without client_credentials in grantTypesSupported', () => {
      const authScheme = {
        grantTypesSupported: ['authorization_code'],
      } as AuthScheme;

      expect(determineGrantType(authScheme)).toBe(
        OAuthGrantType.AUTHORIZATION_CODE,
      );
    });

    it('returns undefined if no flows or grantTypesSupported', () => {
      const authScheme = {} as AuthScheme;

      expect(determineGrantType(authScheme)).toBeUndefined();
    });
  });

  describe('exchangeClientCredentials', () => {
    it('returns the unexchanged credential if token endpoint is missing', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(undefined);

      const result = await exchangeClientCredentials({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('returns the unexchanged credential if clientId or clientSecret is missing', async () => {
      const authCredential = {oauth2: {}} as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );

      const result = await exchangeClientCredentials({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('calls fetchOAuth2Tokens and returns updated credential', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;
      const mockTokens = {accessToken: 'new-token', expiresIn: 3600};

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.createOAuth2TokenRequestBody).mockReturnValue(
        new URLSearchParams(),
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue(mockTokens);

      const result = await exchangeClientCredentials({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(true);
      expect(result.credential.oauth2?.accessToken).toBe('new-token');
    });

    it('returns the unexchanged credential if fetchOAuth2Tokens fails', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await exchangeClientCredentials({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalled();
    });

    it('rethrows when the SSRF guard rejects the token endpoint', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://169.254.169.254/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        new oauth2Utils.OAuth2EndpointNotAllowedError(
          'SSRF protection: not allowed.',
        ),
      );

      await expect(
        exchangeClientCredentials({authCredential, authScheme}),
      ).rejects.toThrow(oauth2Utils.OAuth2EndpointNotAllowedError);
    });

    it('returns the unexchanged credential if fetchOAuth2Tokens fails with non-Error', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        'String error',
      );

      const result = await exchangeClientCredentials({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalled();
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('returns the unexchanged credential if token endpoint is missing', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(undefined);

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('returns the unexchanged credential if required fields are missing', async () => {
      const authCredential = {oauth2: {clientId: 'id'}} as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('parses code from authResponseUri if authCode is missing', async () => {
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          authResponseUri: 'https://callback?code=abc',
        },
      } as AuthCredential;
      const authScheme = {} as AuthScheme;
      const mockTokens = {accessToken: 'new-token'};

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.parseAuthorizationCode).mockReturnValue('abc');
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue(mockTokens);

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(true);
      expect(oauth2Utils.parseAuthorizationCode).toHaveBeenCalledWith(
        'https://callback?code=abc',
      );
    });

    it('returns the unexchanged credential if no code found in authResponseUri', async () => {
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          authResponseUri: 'https://callback',
        },
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.parseAuthorizationCode).mockReturnValue(undefined);

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('calls fetchOAuth2Tokens and returns updated credential', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;
      const mockTokens = {accessToken: 'new-token'};

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue(mockTokens);

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(true);
      expect(result.credential.oauth2?.accessToken).toBe('new-token');
    });

    it('returns the unexchanged credential if fetchOAuth2Tokens fails', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalled();
    });

    it('rethrows when the SSRF guard rejects the token endpoint', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://169.254.169.254/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        new oauth2Utils.OAuth2EndpointNotAllowedError(
          'SSRF protection: not allowed.',
        ),
      );

      await expect(
        exchangeAuthorizationCode({authCredential, authScheme}),
      ).rejects.toThrow(oauth2Utils.OAuth2EndpointNotAllowedError);
    });

    it('returns the unexchanged credential if fetchOAuth2Tokens fails with non-Error', async () => {
      const authCredential = {
        oauth2: {clientId: 'id', clientSecret: 'secret', authCode: 'code'},
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockRejectedValue(
        'String error',
      );

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).toHaveBeenCalled();
    });

    it('throws CredentialExchangeError if state in authResponseUri does not match expected state', async () => {
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          authResponseUri: 'https://callback?code=abc&state=wrong',
          state: 'expected-state',
        },
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.parseAuthorizationCode).mockReturnValue('abc');

      await expect(
        exchangeAuthorizationCode({authCredential, authScheme}),
      ).rejects.toThrow('State mismatch detected');
    });

    it('reports a state mismatch as a mismatch rather than a parse failure', async () => {
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          authResponseUri: 'https://callback?code=abc&state=wrong',
          state: 'expected-state',
        },
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.parseAuthorizationCode).mockReturnValue('abc');

      await expect(
        exchangeAuthorizationCode({authCredential, authScheme}),
      ).rejects.toThrow(
        new CredentialExchangeError(
          'State mismatch detected. Potential CSRF attack.',
        ),
      );
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('throws when the auth response carries no state at all', async () => {
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          authResponseUri: 'https://callback?code=abc',
          state: 'expected-state',
        },
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.parseAuthorizationCode).mockReturnValue('abc');

      await expect(
        exchangeAuthorizationCode({authCredential, authScheme}),
      ).rejects.toThrow(
        new CredentialExchangeError(
          'State mismatch detected. Potential CSRF attack.',
        ),
      );
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('returns the unexchanged credential if authResponseUri cannot be parsed for state validation', async () => {
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          authResponseUri: 'not a url',
          state: 'expected-state',
        },
      } as AuthCredential;
      const authScheme = {} as AuthScheme;

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.parseAuthorizationCode).mockReturnValue('abc');

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(false);
      expect(result.credential).toBe(authCredential);
      expect(result.credential.oauth2?.accessToken).toBeUndefined();
      expect(oauth2Utils.fetchOAuth2Tokens).not.toHaveBeenCalled();
    });

    it('succeeds if state in authResponseUri matches expected state', async () => {
      const authCredential = {
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          authResponseUri: 'https://callback?code=abc&state=correct',
          state: 'correct',
        },
      } as AuthCredential;
      const authScheme = {} as AuthScheme;
      const mockTokens = {accessToken: 'new-token'};

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.parseAuthorizationCode).mockReturnValue('abc');
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue(mockTokens);

      const result = await exchangeAuthorizationCode({
        authCredential,
        authScheme,
      });

      expect(result.wasExchanged).toBe(true);
    });

    it('passes codeVerifier to createOAuth2TokenRequestBody', async () => {
      const authCredential = {
        authType: 'oauth2',
        oauth2: {
          clientId: 'id',
          clientSecret: 'secret',
          authCode: 'code',
          codeVerifier: 'verifier-123',
        },
      } as AuthCredential;
      const authScheme = {} as AuthScheme;
      const mockTokens = {accessToken: 'new-token'};

      vi.mocked(oauth2Utils.getTokenEndpoint).mockReturnValue(
        'https://example.com/token',
      );
      vi.mocked(oauth2Utils.fetchOAuth2Tokens).mockResolvedValue(mockTokens);

      await exchangeAuthorizationCode({authCredential, authScheme});

      expect(oauth2Utils.createOAuth2TokenRequestBody).toHaveBeenCalledWith(
        expect.objectContaining({
          codeVerifier: 'verifier-123',
        }),
      );
    });
  });
});
