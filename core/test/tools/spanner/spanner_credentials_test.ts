/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, AuthCredentialTypes, Context} from '@google/adk';
import {SPANNER_DEFAULT_SCOPES} from '@google/adk/tools/spanner';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
// Not part of the public entry point: the toolset constructor is the only
// caller, so these are imported from the source they live in.
import {
  SPANNER_TOKEN_CACHE_KEY,
  SpannerAccessToken,
  SpannerCredentialsManager,
  validateSpannerCredentialsConfig,
} from '../../../src/tools/spanner/spanner_credentials.js';
import {
  FUNCTION_CALL_ID,
  makeToolContext,
  testAuthClient,
} from './spanner_test_utils.js';

const OAUTH_CONFIG = {clientId: 'client-id', clientSecret: 'client-secret'};

/** Reads the token this manager cached in session state. */
function cachedToken(context: Context): SpannerAccessToken | undefined {
  return context.state.get<SpannerAccessToken>(SPANNER_TOKEN_CACHE_KEY);
}

/** Answers the next `getAuthResponse` with `credential`. */
function stubAuthResponse(
  context: Context,
  credential: AuthCredential | undefined,
): void {
  vi.spyOn(context, 'getAuthResponse').mockReturnValue(credential);
}

describe('validateSpannerCredentialsConfig', () => {
  it.each([
    {field: 'externalAccessTokenKey', value: 'k'},
    {field: 'clientId', value: 'id'},
    {field: 'clientSecret', value: 'secret'},
    {field: 'scopes', value: ['scope']},
  ])('rejects an auth client combined with $field', ({field, value}) => {
    expect(() =>
      validateSpannerCredentialsConfig({
        authClient: testAuthClient(),
        [field]: value,
      }),
    ).toThrow(
      'If credentials are provided, external_access_token_key, client_id,' +
        ' client_secret, and scopes must not be provided.',
    );
  });

  it.each([
    {field: 'clientId', value: 'id'},
    {field: 'clientSecret', value: 'secret'},
    {field: 'scopes', value: ['scope']},
  ])('rejects an external token key combined with $field', ({field, value}) => {
    expect(() =>
      validateSpannerCredentialsConfig({
        externalAccessTokenKey: 'spanner_token',
        [field]: value,
      }),
    ).toThrow(
      'If external_access_token_key is provided, client_id,' +
        ' client_secret, and scopes must not be provided.',
    );
  });

  it.each([
    {label: 'nothing at all', config: {}},
    {label: 'only a client id', config: {clientId: 'id'}},
    {label: 'only a client secret', config: {clientSecret: 'secret'}},
  ])('rejects a config naming $label', ({config}) => {
    expect(() => validateSpannerCredentialsConfig(config)).toThrow(
      'Must provide one of credentials, external_access_token_key, or' +
        ' client_id and client_secret pair.',
    );
  });

  it.each([
    {label: 'an auth client', config: () => ({authClient: testAuthClient()})},
    {
      label: 'an external token key',
      config: () => ({externalAccessTokenKey: 'spanner_token'}),
    },
    {label: 'an OAuth client pair', config: () => OAUTH_CONFIG},
    {
      label: 'an OAuth client pair with scopes',
      config: () => ({...OAUTH_CONFIG, scopes: ['https://example.test/s']}),
    },
  ])('accepts a config naming $label', ({config}) => {
    expect(() => validateSpannerCredentialsConfig(config())).not.toThrow();
  });
});

describe('SpannerCredentialsManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a configured auth client unchanged', async () => {
    const authClient = testAuthClient();
    const manager = new SpannerCredentialsManager({authClient});

    expect(await manager.getAuthClient(makeToolContext())).toBe(authClient);
  });

  it('resolves a configured auth client without a context', async () => {
    const authClient = testAuthClient();
    const manager = new SpannerCredentialsManager({authClient});

    expect(await manager.getAuthClient()).toBe(authClient);
  });

  it.each([
    {label: 'an external token key', config: {externalAccessTokenKey: 'k'}},
    {label: 'an OAuth client pair', config: OAUTH_CONFIG},
  ])('needs a context to resolve $label', async ({config}) => {
    const manager = new SpannerCredentialsManager(config);

    await expect(manager.getAuthClient()).rejects.toThrow(
      'A tool context is required to resolve Spanner credentials from' +
        ' session state. Call the tool through an agent.',
    );
  });

  describe('externalAccessTokenKey', () => {
    it('builds a client from the token in session state', async () => {
      const context = makeToolContext();
      context.state.set('spanner_token', 'external-token');
      const manager = new SpannerCredentialsManager({
        externalAccessTokenKey: 'spanner_token',
      });

      const client = await manager.getAuthClient(context);

      expect(client?.credentials.access_token).toBe('external-token');
    });

    it('throws when session state does not hold the token', async () => {
      const manager = new SpannerCredentialsManager({
        externalAccessTokenKey: 'spanner_token',
      });

      await expect(manager.getAuthClient(makeToolContext())).rejects.toThrow(
        'external_access_token_key is provided but no access token found in' +
          ' tool_context.state with key spanner_token.',
      );
    });
  });

  describe('the OAuth flow', () => {
    it('requests a credential and returns nothing on the first call', async () => {
      const context = makeToolContext();
      const manager = new SpannerCredentialsManager(OAUTH_CONFIG);

      expect(await manager.getAuthClient(context)).toBeUndefined();
      expect(
        context.actions.requestedAuthConfigs[FUNCTION_CALL_ID],
      ).toBeDefined();
    });

    it('asks for the default scopes', async () => {
      const context = makeToolContext();

      await new SpannerCredentialsManager(OAUTH_CONFIG).getAuthClient(context);

      const requested = context.actions.requestedAuthConfigs[FUNCTION_CALL_ID];
      const scheme = requested.authScheme as OpenAPIV3.OAuth2SecurityScheme;
      expect(Object.keys(scheme.flows.authorizationCode?.scopes ?? {})).toEqual(
        [...SPANNER_DEFAULT_SCOPES],
      );
      expect(requested.rawAuthCredential?.authType).toBe(
        AuthCredentialTypes.OAUTH2,
      );
      expect(requested.credentialKey).toBe(SPANNER_TOKEN_CACHE_KEY);
    });

    it('asks for the configured scopes instead when there are some', async () => {
      const context = makeToolContext();
      const manager = new SpannerCredentialsManager({
        ...OAUTH_CONFIG,
        scopes: ['https://example.test/one'],
      });

      await manager.getAuthClient(context);

      const scheme = context.actions.requestedAuthConfigs[FUNCTION_CALL_ID]
        .authScheme as OpenAPIV3.OAuth2SecurityScheme;
      expect(scheme.flows.authorizationCode?.scopes).toEqual({
        'https://example.test/one': 'Access to https://example.test/one',
      });
    });

    it('caches the token once the user authorizes', async () => {
      const context = makeToolContext();
      stubAuthResponse(context, {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          accessToken: 'granted-token',
          refreshToken: 'refresh',
          expiresAt: 1_700_000_000_000,
        },
      });
      const manager = new SpannerCredentialsManager(OAUTH_CONFIG);

      const client = await manager.getAuthClient(context);

      expect(client?.credentials.access_token).toBe('granted-token');
      expect(cachedToken(context)).toEqual({
        accessToken: 'granted-token',
        refreshToken: 'refresh',
        expiresAt: 1_700_000_000_000,
      });
    });

    it('reuses a cached token without asking again', async () => {
      const context = makeToolContext();
      context.state.set(SPANNER_TOKEN_CACHE_KEY, {
        accessToken: 'cached-token',
        expiresAt: Date.now() + 60_000,
      });
      const requestCredential = vi.spyOn(context, 'requestCredential');
      const manager = new SpannerCredentialsManager(OAUTH_CONFIG);

      const client = await manager.getAuthClient(context);

      expect(client?.credentials.access_token).toBe('cached-token');
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('reuses an expired token that carries a refresh token', async () => {
      const context = makeToolContext();
      context.state.set(SPANNER_TOKEN_CACHE_KEY, {
        accessToken: 'stale-token',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 60_000,
      });
      const manager = new SpannerCredentialsManager(OAUTH_CONFIG);

      const client = await manager.getAuthClient(context);

      expect(client?.credentials.access_token).toBe('stale-token');
    });

    it('reuses a cached token that carries no expiry', async () => {
      const context = makeToolContext();
      context.state.set(SPANNER_TOKEN_CACHE_KEY, {
        accessToken: 'token-without-expiry',
      });
      const manager = new SpannerCredentialsManager(OAUTH_CONFIG);

      const client = await manager.getAuthClient(context);

      expect(client?.credentials.access_token).toBe('token-without-expiry');
    });

    it('re-runs the flow for an expired token with no refresh token', async () => {
      const context = makeToolContext();
      context.state.set(SPANNER_TOKEN_CACHE_KEY, {
        accessToken: 'expired-token',
        expiresAt: Date.now() - 60_000,
      });
      const manager = new SpannerCredentialsManager(OAUTH_CONFIG);

      expect(await manager.getAuthClient(context)).toBeUndefined();
      expect(
        context.actions.requestedAuthConfigs[FUNCTION_CALL_ID],
      ).toBeDefined();
    });

    it('re-runs the flow when the response carries no access token', async () => {
      const context = makeToolContext();
      stubAuthResponse(context, {authType: AuthCredentialTypes.OAUTH2});
      const manager = new SpannerCredentialsManager(OAUTH_CONFIG);

      expect(await manager.getAuthClient(context)).toBeUndefined();
      expect(cachedToken(context)).toBeUndefined();
    });
  });
});
