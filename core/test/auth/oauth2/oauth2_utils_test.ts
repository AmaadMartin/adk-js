/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthScheme,
  CustomAuthScheme,
  ExtendedOAuth2,
  OAuth2Auth,
  OAuth2DiscoveryManager,
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
import {AuthorizationServerMetadata} from '../../../src/auth/oauth2/oauth2_discovery.js';
import {
  AuthorizationCodeParams,
  ClientCredentialsParams,
  createOAuth2TokenRequestBody,
  fetchOAuth2Tokens,
  getTokenEndpoint,
  isTokenExpired,
  parseAuthorizationCode,
  populateAuthSchemeFromDiscovery,
  RefreshTokenParams,
} from '../../../src/auth/oauth2/oauth2_utils.js';
import {logger} from '../../../src/utils/logger.js';

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

  describe('populateAuthSchemeFromDiscovery', () => {
    const AUTHORIZATION_ENDPOINT = 'https://issuer.example.com/authorize';
    const TOKEN_ENDPOINT = 'https://issuer.example.com/token';
    const ISSUER_URL = 'https://issuer.example.com';

    /** A discovery manager that answers from memory instead of the network. */
    class StubDiscoveryManager extends OAuth2DiscoveryManager {
      readonly requestedIssuers: string[] = [];

      constructor(
        private readonly metadata: AuthorizationServerMetadata | undefined,
      ) {
        super();
      }

      override async discoverAuthServerMetadata(
        issuerUrl: string,
      ): Promise<AuthorizationServerMetadata | undefined> {
        this.requestedIssuers.push(issuerUrl);
        return this.metadata;
      }
    }

    function stubWithMetadata(): StubDiscoveryManager {
      return new StubDiscoveryManager({
        issuer: ISSUER_URL,
        authorization_endpoint: AUTHORIZATION_ENDPOINT,
        token_endpoint: TOKEN_ENDPOINT,
      });
    }

    let warnSpy: MockInstance<typeof logger.warn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects a plain OAuth2 scheme that names no issuer', async () => {
      const scheme: AuthScheme = {
        type: 'oauth2',
        flows: {implicit: {authorizationUrl: '', scopes: {}}},
      };

      expect(
        await populateAuthSchemeFromDiscovery(scheme, stubWithMetadata()),
      ).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        'No issuerUrl was provided for auto-discovery.',
      );
    });

    it('rejects a custom scheme', async () => {
      const scheme: CustomAuthScheme = {type: 'myProviderScheme'};

      expect(
        await populateAuthSchemeFromDiscovery(scheme, stubWithMetadata()),
      ).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        'No issuerUrl was provided for auto-discovery.',
      );
    });

    it('reports failure when the issuer publishes no metadata', async () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: ISSUER_URL,
        flows: {implicit: {authorizationUrl: '', scopes: {}}},
      };
      const discovery = new StubDiscoveryManager(undefined);

      expect(await populateAuthSchemeFromDiscovery(scheme, discovery)).toBe(
        false,
      );
      expect(discovery.requestedIssuers).toEqual([ISSUER_URL]);
      expect(warnSpy).toHaveBeenCalledWith(
        'Auto-discovery has failed to populate OAuth scheme info.',
      );
      expect(scheme.flows.implicit?.authorizationUrl).toBe('');
    });

    it('fills every empty endpoint of every configured flow', async () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: ISSUER_URL,
        flows: {
          implicit: {authorizationUrl: '', scopes: {}},
          password: {tokenUrl: '', scopes: {}},
          clientCredentials: {tokenUrl: '', scopes: {}},
          authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
        },
      };

      expect(
        await populateAuthSchemeFromDiscovery(scheme, stubWithMetadata()),
      ).toBe(true);
      expect(scheme.flows.implicit?.authorizationUrl).toBe(
        AUTHORIZATION_ENDPOINT,
      );
      expect(scheme.flows.password?.tokenUrl).toBe(TOKEN_ENDPOINT);
      expect(scheme.flows.clientCredentials?.tokenUrl).toBe(TOKEN_ENDPOINT);
      expect(scheme.flows.authorizationCode?.authorizationUrl).toBe(
        AUTHORIZATION_ENDPOINT,
      );
      expect(scheme.flows.authorizationCode?.tokenUrl).toBe(TOKEN_ENDPOINT);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('keeps an endpoint the caller already configured', async () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: ISSUER_URL,
        flows: {
          implicit: {
            authorizationUrl: 'https://own.example.com/auth',
            scopes: {},
          },
          authorizationCode: {
            authorizationUrl: 'https://own.example.com/auth',
            tokenUrl: 'https://own.example.com/token',
            scopes: {},
          },
        },
      };

      expect(
        await populateAuthSchemeFromDiscovery(scheme, stubWithMetadata()),
      ).toBe(true);
      expect(scheme.flows.implicit?.authorizationUrl).toBe(
        'https://own.example.com/auth',
      );
      expect(scheme.flows.authorizationCode?.authorizationUrl).toBe(
        'https://own.example.com/auth',
      );
      expect(scheme.flows.authorizationCode?.tokenUrl).toBe(
        'https://own.example.com/token',
      );
    });

    it('succeeds when the scheme declares no flow to fill', async () => {
      const scheme: ExtendedOAuth2 = {
        type: 'oauth2',
        issuerUrl: ISSUER_URL,
        flows: {},
      };

      expect(
        await populateAuthSchemeFromDiscovery(scheme, stubWithMetadata()),
      ).toBe(true);
      expect(scheme.flows).toEqual({});
    });
  });
});
