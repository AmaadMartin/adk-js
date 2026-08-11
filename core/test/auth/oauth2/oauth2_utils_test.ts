/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  OAuth2Auth,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthorizationCodeParams,
  bindOAuth2ToRequest,
  ClientCredentialsParams,
  createOAuth2TokenRequestBody,
  fetchOAuth2Tokens,
  getTokenEndpoint,
  isTokenExpired,
  parseAuthorizationCode,
  RefreshTokenParams,
} from '../../../src/auth/oauth2/oauth2_utils.js';

describe('oauth2_utils', () => {
  describe('getTokenEndpoint', () => {
    it('returns tokenEndpoint from OpenIdConnectWithConfig', () => {
      const scheme = {
        type: 'openIdConnect',
        tokenEndpoint: 'https://example.com/token',
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBe('https://example.com/token');
    });

    it('returns tokenUrl from flows.authorizationCode', () => {
      const scheme = {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            tokenUrl: 'https://example.com/token-auth',
          },
        },
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBe('https://example.com/token-auth');
    });

    it('returns tokenUrl from flows.clientCredentials', () => {
      const scheme = {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://example.com/token-cc',
          },
        },
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBe('https://example.com/token-cc');
    });

    it('returns undefined if no token URIs are found', () => {
      const scheme = {
        flows: {
          implicit: {
            authorizationUrl: 'https://example.com/auth',
          },
        },
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBeUndefined();
    });

    it('returns undefined if flows is empty', () => {
      const scheme = {
        flows: {},
      } as AuthScheme;
      expect(getTokenEndpoint(scheme)).toBeUndefined();
    });
  });

  describe('fetchOAuth2Tokens', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('fetches tokens successfully and maps snake_case to camelCase', async () => {
      const mockResponse = {
        access_token: 'acc-123',
        refresh_token: 'ref-456',
        expires_in: 3600,
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const body = new URLSearchParams();
      const result = await fetchOAuth2Tokens('https://example.com/token', body);

      expect(result.accessToken).toBe('acc-123');
      expect(result.refreshToken).toBe('ref-456');
      expect(result.expiresIn).toBe(3600);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it('handles missing refresh_token or expires_in', async () => {
      const mockResponse = {
        access_token: 'acc-123',
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const body = new URLSearchParams();
      const result = await fetchOAuth2Tokens('https://example.com/token', body);

      expect(result.accessToken).toBe('acc-123');
      expect(result.refreshToken).toBeUndefined();
      expect(result.expiresIn).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });

    it('throws error if response is not ok', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
      } as Response);

      const body = new URLSearchParams();
      await expect(
        fetchOAuth2Tokens('https://example.com/token', body),
      ).rejects.toThrow('Token request failed with status 401');
    });

    it('does not follow redirects (redirect: error) to prevent SSRF credential leaks', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({access_token: 'acc-123'}),
      } as Response);

      await fetchOAuth2Tokens(
        'https://example.com/token',
        new URLSearchParams(),
      );

      // The blocklist only validates the initial endpoint, so redirects must
      // not be followed or the credential-bearing POST could be redirected to
      // a private/cloud-metadata address.
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/token',
        expect.objectContaining({redirect: 'error'}),
      );
    });

    it('propagates the error when the endpoint attempts a redirect', async () => {
      // With redirect: 'error', the runtime's fetch rejects on any 3xx.
      vi.mocked(fetch).mockRejectedValue(
        new TypeError('fetch failed: unexpected redirect'),
      );

      await expect(
        fetchOAuth2Tokens('https://example.com/token', new URLSearchParams()),
      ).rejects.toThrow();
    });

    it('rejects a token endpoint that targets a blocked host before any fetch', async () => {
      await expect(
        fetchOAuth2Tokens(
          'https://169.254.169.254/token',
          new URLSearchParams(),
        ),
      ).rejects.toThrow('SSRF protection');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('parseAuthorizationCode', () => {
    it('parses code from query string', () => {
      const uri = 'https://example.com/callback?code=super-secret&state=abc';
      expect(parseAuthorizationCode(uri)).toBe('super-secret');
    });

    it('returns undefined if code is missing', () => {
      const uri = 'https://example.com/callback?state=abc';
      expect(parseAuthorizationCode(uri)).toBeUndefined();
    });

    it('returns undefined and logs warning for invalid URI', () => {
      const uri = 'not-a-valid-url';
      expect(parseAuthorizationCode(uri)).toBeUndefined();
    });
  });

  describe('createOAuth2TokenRequestBody', () => {
    it('creates body for client_credentials', () => {
      const params: ClientCredentialsParams = {
        grantType: 'client_credentials',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      };

      const body = createOAuth2TokenRequestBody(params);

      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
    });

    it('creates body for authorization_code', () => {
      const params: AuthorizationCodeParams = {
        grantType: 'authorization_code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'auth-code',
        redirectUri: 'https://example.com/callback',
      };

      const body = createOAuth2TokenRequestBody(params);

      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('redirect_uri')).toBe('https://example.com/callback');
    });

    it('creates body for authorization_code with code_verifier', () => {
      const params: AuthorizationCodeParams = {
        grantType: 'authorization_code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        code: 'auth-code',
        redirectUri: 'https://example.com/callback',
        codeVerifier: 'verifier-123',
      };

      const body = createOAuth2TokenRequestBody(params);

      expect(body.get('code_verifier')).toBe('verifier-123');
    });

    it('creates body for refresh_token', () => {
      const params: RefreshTokenParams = {
        grantType: 'refresh_token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      };

      const body = createOAuth2TokenRequestBody(params);

      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('client_secret')).toBe('client-secret');
      expect(body.get('refresh_token')).toBe('refresh-token');
    });
  });

  describe('isTokenExpired', () => {
    it('returns false if expiresAt is not a number', () => {
      expect(isTokenExpired({} as unknown as OAuth2Auth)).toBe(false);
      expect(
        isTokenExpired({expiresAt: 'not-a-number'} as unknown as OAuth2Auth),
      ).toBe(false);
    });

    it('returns false if token is not expired (future expiresAt in milliseconds)', () => {
      const futureTimeMs = Date.now() + 3600 * 1000; // 1 hour in future
      expect(isTokenExpired({expiresAt: futureTimeMs} as OAuth2Auth)).toBe(
        false,
      );
    });

    it('returns true if token is expired (past expiresAt in milliseconds)', () => {
      const pastTimeMs = Date.now() - 3600 * 1000; // 1 hour in past
      expect(isTokenExpired({expiresAt: pastTimeMs} as OAuth2Auth)).toBe(true);
    });

    it('uses leeway (default 60s)', () => {
      const nearFutureTimeMs = Date.now() + 30 * 1000; // 30s in future
      // With 60s leeway, 30s should be considered expired
      expect(isTokenExpired({expiresAt: nearFutureTimeMs} as OAuth2Auth)).toBe(
        true,
      );
    });
  });

  describe('bindOAuth2ToRequest', () => {
    const FROZEN_NONCE = 'adk-issued-nonce';
    const REDIRECT_URI = 'https://app.example.com/callback';

    const OAUTH2_SCHEME: AuthScheme = {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://oauth2.example.com/token',
          scopes: {},
        },
      },
    };

    /** Every OAuth2 field the tool configured or ADK minted. */
    const TOOL_OWNED_OAUTH2: OAuth2Auth = {
      clientId: 'adk-client',
      clientSecret: 'adk-secret',
      redirectUri: REDIRECT_URI,
      codeVerifier: 'adk-verifier',
      state: FROZEN_NONCE,
      authUri: `https://auth.example.com/authorize?state=${FROZEN_NONCE}`,
      nonce: 'adk-nonce',
      audience: 'adk-audience',
      tokenEndpointAuthMethod: 'client_secret_post',
    };

    /** Every OAuth2 field a resume message may contribute. */
    const RESUME_CONTRIBUTED_OAUTH2: OAuth2Auth = {
      authResponseUri: `${REDIRECT_URI}?code=good-code&state=${FROZEN_NONCE}`,
      authCode: 'good-code',
      accessToken: 'resume-token',
      refreshToken: 'resume-refresh',
      idToken: 'resume-id-token',
      expiresIn: 3600,
      expiresAt: 1780000000000,
    };

    /** The same fields as TOOL_OWNED_OAUTH2, under attacker control. */
    const ATTACKER_OWNED_OAUTH2: OAuth2Auth = {
      clientId: 'attacker-client',
      clientSecret: 'attacker-secret',
      redirectUri: 'https://attacker.example.com/callback',
      codeVerifier: 'attacker-verifier',
      state: 'attacker-state',
      authUri: 'https://attacker.example.com/authorize',
      nonce: 'attacker-nonce',
      audience: 'attacker-audience',
      tokenEndpointAuthMethod: 'none',
    };

    const FROZEN_OAUTH2_CONFIG: AuthConfig = {
      credentialKey: 'testKey',
      authScheme: OAUTH2_SCHEME,
      exchangedAuthCredential: oauth2Credential(TOOL_OWNED_OAUTH2),
    };

    function oauth2Credential(oauth2: OAuth2Auth): AuthCredential {
      return {authType: AuthCredentialTypes.OAUTH2, oauth2};
    }

    it('keeps the tool-owned fields and takes only the resumable ones', () => {
      const bound = bindOAuth2ToRequest(
        FROZEN_OAUTH2_CONFIG,
        oauth2Credential({
          ...ATTACKER_OWNED_OAUTH2,
          ...RESUME_CONTRIBUTED_OAUTH2,
        }),
      );

      expect(bound?.oauth2).toEqual({
        ...TOOL_OWNED_OAUTH2,
        ...RESUME_CONTRIBUTED_OAUTH2,
      });
    });

    it('keeps a frozen value when the resume leaves the field undefined', () => {
      const frozen: AuthConfig = {
        ...FROZEN_OAUTH2_CONFIG,
        exchangedAuthCredential: oauth2Credential({
          ...TOOL_OWNED_OAUTH2,
          accessToken: 'frozen-token',
        }),
      };

      const bound = bindOAuth2ToRequest(
        frozen,
        oauth2Credential({accessToken: undefined, authCode: 'good-code'}),
      );

      expect(bound?.oauth2?.accessToken).toBe('frozen-token');
      expect(bound?.oauth2?.authCode).toBe('good-code');
    });

    it('falls back to the raw credential when no exchanged one was frozen', () => {
      const frozen: AuthConfig = {
        credentialKey: 'testKey',
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: oauth2Credential({clientId: 'adk-client'}),
      };

      const bound = bindOAuth2ToRequest(
        frozen,
        oauth2Credential({clientId: 'attacker-client', authCode: 'good-code'}),
      );

      expect(bound?.oauth2).toEqual({
        clientId: 'adk-client',
        authCode: 'good-code',
      });
    });

    it('returns the frozen credential when the resume carries none', () => {
      const bound = bindOAuth2ToRequest(FROZEN_OAUTH2_CONFIG, undefined);

      expect(bound?.oauth2).toEqual(TOOL_OWNED_OAUTH2);
    });

    it('returns the resume credential when the request froze no oauth2', () => {
      const apiKeyCredential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'user-value',
      };

      const bound = bindOAuth2ToRequest(
        {
          credentialKey: 'testKey',
          authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
        },
        apiKeyCredential,
      );

      expect(bound).toBe(apiKeyCredential);
    });
  });
});
