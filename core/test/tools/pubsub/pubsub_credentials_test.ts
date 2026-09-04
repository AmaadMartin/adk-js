/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports adk-python `tests/unittests/tools/pubsub/test_pubsub_credentials.py`
 * as far as the credential shapes this port supports. The `it` titles of the
 * ported cases keep the Python test names so the two suites stay greppable.
 */

import {AuthCredential, AuthCredentialTypes, Context} from '@google/adk';
import {PUBSUB_DEFAULT_SCOPES} from '@google/adk/tools/pubsub';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
// Not part of the public entry point: the toolset constructor is the only
// caller, so these are imported from the source they live in.
import {
  PUBSUB_TOKEN_CACHE_KEY,
  PubSubAccessToken,
  PubSubCredentialsManager,
  validatePubSubCredentialsConfig,
} from '../../../src/tools/pubsub/pubsub_credentials.js';
import {
  FUNCTION_CALL_ID,
  makeToolContext,
  testServiceAccount,
} from './pubsub_test_utils.js';

const OAUTH_CONFIG = {clientId: 'abc', clientSecret: 'def'};

/** Reads the grant this manager cached in session state. */
function cachedToken(context: Context): PubSubAccessToken | undefined {
  return context.state.get<PubSubAccessToken>(PUBSUB_TOKEN_CACHE_KEY);
}

/** Answers the next `getAuthResponse` with `credential`. */
function stubAuthResponse(
  context: Context,
  credential: AuthCredential | undefined,
): void {
  vi.spyOn(context, 'getAuthResponse').mockReturnValue(credential);
}

describe('validatePubSubCredentialsConfig', () => {
  it('test_pubsub_credentials_config_client_id_secret', () => {
    expect(() => validatePubSubCredentialsConfig(OAUTH_CONFIG)).not.toThrow();
  });

  it('test_pubsub_credentials_config_existing_creds', () => {
    expect(() =>
      validatePubSubCredentialsConfig({credentials: testServiceAccount()}),
    ).not.toThrow();
  });

  it('test_pubsub_credentials_config_both_credentials_and_client_provided', () => {
    expect(() =>
      validatePubSubCredentialsConfig({
        credentials: testServiceAccount(),
        ...OAUTH_CONFIG,
      }),
    ).toThrow(
      'If a service account is provided, client_id and client_secret must' +
        ' not be provided.',
    );
  });

  it.each([
    {label: 'only a client id', config: {clientId: 'abc'}},
    {label: 'only a client secret', config: {clientSecret: 'def'}},
  ])('rejects a config naming $label', ({config}) => {
    expect(() => validatePubSubCredentialsConfig(config)).toThrow(
      'Must provide the client_id and client_secret pair together, or' +
        ' neither.',
    );
  });

  it('rejects a key file combined with an OAuth client', () => {
    expect(() =>
      validatePubSubCredentialsConfig({
        keyFilename: '/keys/agent.json',
        ...OAUTH_CONFIG,
      }),
    ).toThrow(
      'If a service account is provided, client_id and client_secret must' +
        ' not be provided.',
    );
  });

  it('rejects a key file combined with inline credentials', () => {
    expect(() =>
      validatePubSubCredentialsConfig({
        credentials: testServiceAccount(),
        keyFilename: '/keys/agent.json',
      }),
    ).toThrow('Provide either credentials or keyFilename, not both.');
  });

  it.each([
    {label: 'nothing at all', config: {}},
    {label: 'a key file', config: {keyFilename: '/keys/agent.json'}},
    {
      label: 'an OAuth client with scopes',
      config: {...OAUTH_CONFIG, scopes: ['https://example.test/s']},
    },
  ])('accepts a config naming $label', ({config}) => {
    expect(() => validatePubSubCredentialsConfig(config)).not.toThrow();
  });
});

describe('PubSubCredentialsManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a configured service account unchanged', () => {
    const credentials = testServiceAccount();
    const manager = new PubSubCredentialsManager({credentials});

    expect(manager.resolve(makeToolContext())).toEqual({
      credentials,
      scopes: [...PUBSUB_DEFAULT_SCOPES],
    });
  });

  it('resolves a service account without a context', () => {
    const credentials = testServiceAccount();

    expect(new PubSubCredentialsManager({credentials}).resolve()).toEqual({
      credentials,
      scopes: [...PUBSUB_DEFAULT_SCOPES],
    });
  });

  it('passes a key file through to the client', () => {
    const manager = new PubSubCredentialsManager({
      keyFilename: '/keys/agent.json',
    });

    expect(manager.resolve()).toEqual({
      keyFilename: '/keys/agent.json',
      scopes: [...PUBSUB_DEFAULT_SCOPES],
    });
  });

  it('falls back to default credentials when the config names none', () => {
    expect(new PubSubCredentialsManager({}).resolve()).toEqual({
      scopes: [...PUBSUB_DEFAULT_SCOPES],
    });
  });

  it('does not share its scopes array with the config', () => {
    const scopes = ['https://example.test/one'];
    const manager = new PubSubCredentialsManager({keyFilename: '/k', scopes});

    scopes.push('https://example.test/two');

    expect(manager.resolve()?.scopes).toEqual(['https://example.test/one']);
  });

  it('needs a context to run the OAuth flow', () => {
    const manager = new PubSubCredentialsManager(OAUTH_CONFIG);

    expect(() => manager.resolve()).toThrow(
      'A tool context is required to resolve Pub/Sub credentials from' +
        ' session state. Call the tool through an agent.',
    );
  });

  describe('the OAuth flow', () => {
    it('requests a credential and returns nothing on the first call', () => {
      const context = makeToolContext();
      const manager = new PubSubCredentialsManager(OAUTH_CONFIG);

      expect(manager.resolve(context)).toBeUndefined();
      expect(
        context.actions.requestedAuthConfigs[FUNCTION_CALL_ID],
      ).toBeDefined();
    });

    it('asks for the default scopes', () => {
      const context = makeToolContext();

      new PubSubCredentialsManager(OAUTH_CONFIG).resolve(context);

      const requested = context.actions.requestedAuthConfigs[FUNCTION_CALL_ID];
      const scheme = requested.authScheme as OpenAPIV3.OAuth2SecurityScheme;
      expect(Object.keys(scheme.flows.authorizationCode?.scopes ?? {})).toEqual(
        [...PUBSUB_DEFAULT_SCOPES],
      );
      expect(requested.rawAuthCredential?.authType).toBe(
        AuthCredentialTypes.OAUTH2,
      );
      expect(requested.credentialKey).toBe(PUBSUB_TOKEN_CACHE_KEY);
    });

    it('asks for the configured scopes instead when there are some', () => {
      const context = makeToolContext();
      const manager = new PubSubCredentialsManager({
        ...OAUTH_CONFIG,
        scopes: ['https://example.test/one'],
      });

      manager.resolve(context);

      const scheme = context.actions.requestedAuthConfigs[FUNCTION_CALL_ID]
        .authScheme as OpenAPIV3.OAuth2SecurityScheme;
      expect(scheme.flows.authorizationCode?.scopes).toEqual({
        'https://example.test/one': 'Access to https://example.test/one',
      });
    });

    it('caches the grant once the user authorizes', () => {
      const context = makeToolContext();
      stubAuthResponse(context, {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          accessToken: 'granted-token',
          refreshToken: 'refresh',
          expiresAt: 1_700_000_000_000,
        },
      });
      const manager = new PubSubCredentialsManager(OAUTH_CONFIG);

      expect(manager.resolve(context)).toEqual({
        credentials: {
          type: 'authorized_user',
          client_id: 'abc',
          client_secret: 'def',
          refresh_token: 'refresh',
        },
        scopes: [...PUBSUB_DEFAULT_SCOPES],
      });
      expect(cachedToken(context)).toEqual({
        accessToken: 'granted-token',
        refreshToken: 'refresh',
        expiresAt: 1_700_000_000_000,
      });
    });

    it('reuses a cached grant without asking again', () => {
      const context = makeToolContext();
      context.state.set(PUBSUB_TOKEN_CACHE_KEY, {
        accessToken: 'cached-token',
        refreshToken: 'cached-refresh',
      });
      const requestCredential = vi.spyOn(context, 'requestCredential');
      const manager = new PubSubCredentialsManager(OAUTH_CONFIG);

      expect(manager.resolve(context)?.credentials).toEqual({
        type: 'authorized_user',
        client_id: 'abc',
        client_secret: 'def',
        refresh_token: 'cached-refresh',
      });
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('re-runs the flow for a cached grant with no refresh token', () => {
      const context = makeToolContext();
      context.state.set(PUBSUB_TOKEN_CACHE_KEY, {accessToken: 'expired-token'});
      const manager = new PubSubCredentialsManager(OAUTH_CONFIG);

      expect(manager.resolve(context)).toBeUndefined();
      expect(
        context.actions.requestedAuthConfigs[FUNCTION_CALL_ID],
      ).toBeDefined();
    });

    it('re-runs the flow when the response carries no access token', () => {
      const context = makeToolContext();
      stubAuthResponse(context, {authType: AuthCredentialTypes.OAUTH2});
      const manager = new PubSubCredentialsManager(OAUTH_CONFIG);

      expect(manager.resolve(context)).toBeUndefined();
      expect(cachedToken(context)).toBeUndefined();
    });

    it('reports a grant that carries no refresh token', () => {
      const context = makeToolContext();
      stubAuthResponse(context, {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'granted-token'},
      });
      const manager = new PubSubCredentialsManager(OAUTH_CONFIG);

      expect(() => manager.resolve(context)).toThrow(
        'The authorization did not return a refresh token, which Pub/Sub' +
          ' needs to authenticate as this user. Request offline access.',
      );
    });
  });
});
