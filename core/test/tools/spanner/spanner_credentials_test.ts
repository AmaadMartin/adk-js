/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  InputValidationError,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {UserRefreshClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';

import {
  GoogleCredentialsManager,
  googleCredentialKey,
} from '../../../src/tools/google_credentials.js';
import {
  SPANNER_DEFAULT_SCOPE,
  SPANNER_TOKEN_CACHE_KEY,
  SpannerCredentialsConfig,
} from '../../../src/tools/spanner/spanner_credentials.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';
const SPANNER_ADMIN_SCOPE = 'https://www.googleapis.com/auth/spanner.admin';
const SPANNER_DATA_SCOPE = 'https://www.googleapis.com/auth/spanner.data';
const FUNCTION_CALL_ID = 'test-function-call-id';

function createToolContext(state: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'test-user',
        state,
      }),
      pluginManager: new PluginManager([]),
    }),
    functionCallId: FUNCTION_CALL_ID,
  });
}

/** A user credential, adk-js' equivalent of Python's `oauth2.Credentials`. */
function createUserClient(): UserRefreshClient {
  return new UserRefreshClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: 'user-refresh-token',
  });
}

/** Asserts the construction fails with exactly this validation message. */
function expectInputValidationError(
  construct: () => SpannerCredentialsConfig,
  message: string,
): void {
  expect(construct).toThrowError(InputValidationError);
  expect(construct).toThrowError(new InputValidationError(message));
}

describe('Spanner credential constants', () => {
  it('names the cache key adk-python writes to shared session state', () => {
    expect(SPANNER_TOKEN_CACHE_KEY).toBe('spanner_token_cache');
  });

  it('lists the two Spanner scopes in adk-python order', () => {
    expect(SPANNER_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/spanner.admin',
      'https://www.googleapis.com/auth/spanner.data',
    ]);
  });
});

describe('SpannerCredentialsConfig', () => {
  it('defaults the scopes of a user credential that carries none', () => {
    const credentials = createUserClient();

    const config = new SpannerCredentialsConfig({credentials});

    expect(config.credentials).toBe(credentials);
    expect(config.clientId).toBe(CLIENT_ID);
    expect(config.clientSecret).toBe(CLIENT_SECRET);
    expect(config.scopes).toEqual([SPANNER_ADMIN_SCOPE, SPANNER_DATA_SCOPE]);
    expect(config.tokenCacheKey).toBe('spanner_token_cache');
  });

  it('defaults the scopes of an OAuth2 client', () => {
    const config = new SpannerCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(config.scopes).toEqual([SPANNER_ADMIN_SCOPE, SPANNER_DATA_SCOPE]);
    expect(config.tokenCacheKey).toBe('spanner_token_cache');
  });

  it('keeps the scopes the caller named', () => {
    const config = new SpannerCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: [SPANNER_DATA_SCOPE],
    });

    expect(config.scopes).toEqual([SPANNER_DATA_SCOPE]);
  });

  it('treats an empty scope list as no scopes', () => {
    const config = new SpannerCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: [],
    });

    expect(config.scopes).toEqual([SPANNER_ADMIN_SCOPE, SPANNER_DATA_SCOPE]);
  });

  it('defaults the scopes of an external access token', () => {
    const config = new SpannerCredentialsConfig({
      externalAccessTokenKey: 'my_spanner_token',
    });

    expect(config.externalAccessTokenKey).toBe('my_spanner_token');
    expect(config.scopes).toEqual([SPANNER_ADMIN_SCOPE, SPANNER_DATA_SCOPE]);
    expect(config.tokenCacheKey).toBe('spanner_token_cache');
  });

  it('gives every instance its own copy of the default scopes', () => {
    const first = new SpannerCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const second = new SpannerCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(first.scopes).not.toBe(second.scopes);

    first.scopes?.push('https://www.googleapis.com/auth/cloud-platform');

    expect(second.scopes).toEqual([SPANNER_ADMIN_SCOPE, SPANNER_DATA_SCOPE]);
    expect(SPANNER_DEFAULT_SCOPE).toEqual([
      SPANNER_ADMIN_SCOPE,
      SPANNER_DATA_SCOPE,
    ]);
  });
});

describe('SpannerCredentialsConfig inherited validation', () => {
  it('rejects credentials combined with an external access token key', () => {
    expectInputValidationError(
      () =>
        new SpannerCredentialsConfig({
          credentials: createUserClient(),
          externalAccessTokenKey: 'my_spanner_token',
        }),
      'If credentials are provided, externalAccessTokenKey, clientId, ' +
        'clientSecret, and scopes must not be provided.',
    );
  });

  it('rejects an external access token key combined with scopes', () => {
    expectInputValidationError(
      () =>
        new SpannerCredentialsConfig({
          externalAccessTokenKey: 'my_spanner_token',
          scopes: [SPANNER_DATA_SCOPE],
        }),
      'If externalAccessTokenKey is provided, clientId, clientSecret, and ' +
        'scopes must not be provided.',
    );
  });

  it('rejects a client id with no client secret', () => {
    expectInputValidationError(
      () => new SpannerCredentialsConfig({clientId: CLIENT_ID}),
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  });

  it('rejects a configuration naming no credential mode', () => {
    expectInputValidationError(
      () => new SpannerCredentialsConfig({}),
      'Must provide one of credentials, externalAccessTokenKey, or clientId ' +
        'and clientSecret pair.',
    );
  });
});

describe('SpannerCredentialsConfig with GoogleCredentialsManager', () => {
  it('caches a completed consent flow under the Spanner key', async () => {
    const config = new SpannerCredentialsConfig({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const authResponse: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        accessToken: 'granted-access-token',
        refreshToken: 'granted-refresh-token',
      },
    };
    const context = createToolContext({
      [`temp:${googleCredentialKey(CLIENT_ID, [
        SPANNER_ADMIN_SCOPE,
        SPANNER_DATA_SCOPE,
      ])}`]: authResponse,
    });

    const credentials = await new GoogleCredentialsManager(
      config,
    ).getValidCredentials(context);

    expect(credentials?.credentials.access_token).toBe('granted-access-token');
    const cached = context.state.get<string>('spanner_token_cache');
    expect(cached).toBeDefined();
    expect(JSON.parse(cached ?? '')).toMatchObject({
      type: 'authorized_user',
      token: 'granted-access-token',
      refresh_token: 'granted-refresh-token',
      scopes: [SPANNER_ADMIN_SCOPE, SPANNER_DATA_SCOPE],
    });
  });
});
