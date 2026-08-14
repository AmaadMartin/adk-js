/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthScheme, ExtendedOAuth2, OAuth2Auth} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthorizationCodeParams,
  ClientCredentialsParams,
  createOAuth2TokenRequestBody,
  fetchOAuth2Tokens,
  getTokenEndpoint,
  isTokenExpired,
  parseAuthorizationCode,
  populateOAuth2Endpoints,
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

  describe('populateOAuth2Endpoints', () => {
    const ISSUER_URL = 'https://auth.example.com';
    const AUTHORIZATION_ENDPOINT = 'https://auth.example.com/authorize';
    const TOKEN_ENDPOINT = 'https://auth.example.com/token';
    const PRESET_URL = 'https://preset.example/token';

    function discoveryResponse(): Response {
      return new Response(
        JSON.stringify({
          issuer: ISSUER_URL,
          authorization_endpoint: AUTHORIZATION_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    }

    function scheme(
      flows: ExtendedOAuth2['flows'],
      issuerUrl = ISSUER_URL,
    ): ExtendedOAuth2 {
      return {type: 'oauth2', issuerUrl, flows};
    }

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('fills both authorization-code endpoints from the discovered metadata', async () => {
      vi.mocked(fetch).mockImplementation(async () => discoveryResponse());
      const authScheme = scheme({
        authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(true);
      expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe(
        AUTHORIZATION_ENDPOINT,
      );
      expect(authScheme.flows.authorizationCode?.tokenUrl).toBe(TOKEN_ENDPOINT);
    });

    it('fills every empty slot of every configured flow', async () => {
      vi.mocked(fetch).mockImplementation(async () => discoveryResponse());
      const authScheme = scheme({
        implicit: {authorizationUrl: '', scopes: {}},
        password: {tokenUrl: '', scopes: {}},
        clientCredentials: {tokenUrl: '', scopes: {}},
        authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(true);
      expect(authScheme.flows.implicit?.authorizationUrl).toBe(
        AUTHORIZATION_ENDPOINT,
      );
      expect(authScheme.flows.password?.tokenUrl).toBe(TOKEN_ENDPOINT);
      expect(authScheme.flows.clientCredentials?.tokenUrl).toBe(TOKEN_ENDPOINT);
      expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe(
        AUTHORIZATION_ENDPOINT,
      );
      expect(authScheme.flows.authorizationCode?.tokenUrl).toBe(TOKEN_ENDPOINT);
    });

    it('keeps an endpoint the user configured and fills only the empty one', async () => {
      vi.mocked(fetch).mockImplementation(async () => discoveryResponse());
      const authScheme = scheme({
        authorizationCode: {
          authorizationUrl: '',
          tokenUrl: PRESET_URL,
          scopes: {},
        },
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(true);
      expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe(
        AUTHORIZATION_ENDPOINT,
      );
      expect(authScheme.flows.authorizationCode?.tokenUrl).toBe(PRESET_URL);
    });

    it('keeps the configured slots of a partly configured set of flows', async () => {
      vi.mocked(fetch).mockImplementation(async () => discoveryResponse());
      const authScheme = scheme({
        implicit: {authorizationUrl: PRESET_URL, scopes: {}},
        password: {tokenUrl: '', scopes: {}},
        clientCredentials: {tokenUrl: PRESET_URL, scopes: {}},
        authorizationCode: {
          authorizationUrl: '',
          tokenUrl: PRESET_URL,
          scopes: {},
        },
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(true);
      expect(authScheme.flows.implicit?.authorizationUrl).toBe(PRESET_URL);
      expect(authScheme.flows.password?.tokenUrl).toBe(TOKEN_ENDPOINT);
      expect(authScheme.flows.clientCredentials?.tokenUrl).toBe(PRESET_URL);
      expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe(
        AUTHORIZATION_ENDPOINT,
      );
      expect(authScheme.flows.authorizationCode?.tokenUrl).toBe(PRESET_URL);
    });

    it('fills the password flow with the token endpoint', async () => {
      vi.mocked(fetch).mockImplementation(async () => discoveryResponse());
      const authScheme = scheme({password: {tokenUrl: '', scopes: {}}});

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(true);
      expect(authScheme.flows.password?.tokenUrl).toBe(TOKEN_ENDPOINT);
    });

    it('fills the client-credentials flow with the token endpoint', async () => {
      vi.mocked(fetch).mockImplementation(async () => discoveryResponse());
      const authScheme = scheme({
        clientCredentials: {tokenUrl: '', scopes: {}},
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(true);
      expect(authScheme.flows.clientCredentials?.tokenUrl).toBe(TOKEN_ENDPOINT);
    });

    it('fills an authorization-code flow that is missing only its token URL', async () => {
      vi.mocked(fetch).mockImplementation(async () => discoveryResponse());
      const authScheme = scheme({
        authorizationCode: {
          authorizationUrl: PRESET_URL,
          tokenUrl: '',
          scopes: {},
        },
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(true);
      expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe(
        PRESET_URL,
      );
      expect(authScheme.flows.authorizationCode?.tokenUrl).toBe(TOKEN_ENDPOINT);
    });

    it('leaves the endpoints empty when the provider serves no metadata', async () => {
      vi.mocked(fetch).mockImplementation(
        async () => new Response(null, {status: 404}),
      );
      const authScheme = scheme({
        authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe('');
      expect(authScheme.flows.authorizationCode?.tokenUrl).toBe('');
    });

    it('resolves instead of rejecting when the discovery request fails', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network unreachable'));
      const authScheme = scheme({
        authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe('');
    });

    it('does not discover when every configured flow is already populated', async () => {
      const authScheme = scheme({
        implicit: {authorizationUrl: PRESET_URL, scopes: {}},
        password: {tokenUrl: PRESET_URL, scopes: {}},
        clientCredentials: {tokenUrl: PRESET_URL, scopes: {}},
        authorizationCode: {
          authorizationUrl: PRESET_URL,
          tokenUrl: PRESET_URL,
          scopes: {},
        },
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not discover when the only configured flow is populated', async () => {
      const authScheme = scheme({
        implicit: {authorizationUrl: PRESET_URL, scopes: {}},
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not discover for an OAuth2 scheme that carries no issuer URL', async () => {
      const authScheme: AuthScheme = {
        type: 'oauth2',
        flows: {
          authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
        },
      };

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not discover for an empty issuer URL', async () => {
      const authScheme = scheme(
        {authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}}},
        '',
      );

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not discover for a scheme whose configuration declares no flows', async () => {
      // User configuration is parsed at runtime, so `flows` can be absent even
      // though the OpenAPI type declares it.
      const authScheme: AuthScheme = JSON.parse(
        '{"type":"oauth2","issuerUrl":"https://auth.example.com"}',
      );

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not discover from an issuer URL the SSRF gate rejects', async () => {
      const authScheme = scheme(
        {authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}}},
        'http://auth.example.com',
      );

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(authScheme.flows.authorizationCode?.authorizationUrl).toBe('');
    });

    it('discovers once and reuses the endpoints it wrote onto the scheme', async () => {
      vi.mocked(fetch).mockImplementation(async () => discoveryResponse());
      const authScheme = scheme({
        authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
      });

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(true);
      const callsAfterFirst = vi.mocked(fetch).mock.calls.length;

      await expect(populateOAuth2Endpoints(authScheme)).resolves.toBe(false);
      expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterFirst);
      expect(authScheme.flows.authorizationCode?.tokenUrl).toBe(TOKEN_ENDPOINT);
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
});
