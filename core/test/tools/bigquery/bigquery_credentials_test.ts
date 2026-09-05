/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  BIGQUERY_CREDENTIAL_KEY,
  BIGQUERY_TOKEN_CACHE_KEY,
  BigQueryCredentials,
  BigQueryCredentialsConfig,
  DEFAULT_BIGQUERY_SCOPES,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {BigQueryCredentialsManager} from '../../../src/tools/bigquery/bigquery_credentials.js';
import {createToolContext} from './bigquery_test_utils.js';

const CLIENT_PAIR: BigQueryCredentialsConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

const CACHED: BigQueryCredentials = {
  clientId: 'cached-id',
  clientSecret: 'cached-secret',
  refreshToken: 'cached-refresh',
};

/** The credential an ADK auth response carries once the user consents. */
function authResponse(oauth2: {refreshToken?: string}): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

/** Reads the scope names off the requested OAuth2 authorization-code flow. */
function requestedScopes(scheme: AuthScheme): string[] {
  if (scheme.type !== 'oauth2') {
    return expect.fail(`expected an oauth2 scheme, got ${scheme.type}`);
  }
  return Object.keys(scheme.flows.authorizationCode?.scopes ?? {});
}

/**
 * Constructs the manager the way an untyped JavaScript caller can.
 *
 * `BigQueryCredentialsConfig` is a union that rejects each configuration below
 * at compile time, which is why reaching the runtime guards needs one cast.
 */
function constructFromUntypedConfig(config: Record<string, unknown>): void {
  new BigQueryCredentialsManager(config as BigQueryCredentialsConfig);
}

describe('BigQueryCredentialsManager construction', () => {
  it('rejects a configuration with neither a credential nor a client pair', () => {
    expect(() => constructFromUntypedConfig({})).toThrow(
      /must provide either credentials, or a clientId and clientSecret/,
    );
  });

  it('rejects a client id without a client secret', () => {
    expect(() => constructFromUntypedConfig({clientId: 'client-id'})).toThrow(
      /must provide either credentials/,
    );
  });

  it('rejects a configuration carrying both a credential and a client pair', () => {
    expect(() =>
      constructFromUntypedConfig({
        credentials: {clientId: 'a', clientSecret: 'b', refreshToken: 'c'},
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
    ).toThrow(/cannot provide both existing credentials/);
  });

  it('rejects a configured credential without a refresh token', () => {
    expect(
      () =>
        new BigQueryCredentialsManager({
          credentials: {clientId: 'a', clientSecret: 'b'},
        }),
    ).toThrow(
      /BigQueryCredentialsConfig.credentials must carry a clientId, a clientSecret and a refreshToken/,
    );
  });
});

describe('BigQueryCredentialsManager.getValidCredentials', () => {
  it('returns the cached credential without running the OAuth flow', async () => {
    const manager = new BigQueryCredentialsManager(CLIENT_PAIR);
    const context = createToolContext({
      state: {[BIGQUERY_TOKEN_CACHE_KEY]: CACHED},
    });

    await expect(manager.getValidCredentials(context)).resolves.toEqual(CACHED);
    expect(context.actions.requestedAuthConfigs).toEqual({});
  });

  it('returns the configured credential when there is no cached one', async () => {
    const manager = new BigQueryCredentialsManager({
      credentials: {
        clientId: 'configured-id',
        clientSecret: 'configured-secret',
        refreshToken: 'configured-refresh',
      },
    });

    await expect(
      manager.getValidCredentials(createToolContext()),
    ).resolves.toEqual({
      clientId: 'configured-id',
      clientSecret: 'configured-secret',
      refreshToken: 'configured-refresh',
    });
  });

  it('requests a credential and resolves undefined when none exists', async () => {
    const manager = new BigQueryCredentialsManager(CLIENT_PAIR);
    const context = createToolContext({functionCallId: 'fc-7'});

    await expect(manager.getValidCredentials(context)).resolves.toBeUndefined();

    const requested = context.actions.requestedAuthConfigs['fc-7'];
    expect(requested.credentialKey).toBe(BIGQUERY_CREDENTIAL_KEY);
    expect(requested.rawAuthCredential?.oauth2?.clientId).toBe('client-id');
    expect(requestedScopes(requested.authScheme)).toEqual(
      DEFAULT_BIGQUERY_SCOPES,
    );
  });

  it('requests the scopes the caller configured', async () => {
    const manager = new BigQueryCredentialsManager({
      ...CLIENT_PAIR,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const context = createToolContext({functionCallId: 'fc-8'});

    await manager.getValidCredentials(context);

    expect(
      requestedScopes(context.actions.requestedAuthConfigs['fc-8'].authScheme),
    ).toEqual(['https://www.googleapis.com/auth/cloud-platform']);
  });

  it('converts a completed auth response and caches it in session state', async () => {
    const manager = new BigQueryCredentialsManager(CLIENT_PAIR);
    const context = createToolContext({
      state: {
        [`temp:${BIGQUERY_CREDENTIAL_KEY}`]: authResponse({
          refreshToken: 'fresh-refresh',
        }),
      },
    });

    const credentials = await manager.getValidCredentials(context);

    expect(credentials).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'fresh-refresh',
    });
    expect(context.state.get(BIGQUERY_TOKEN_CACHE_KEY)).toEqual(credentials);
    expect(context.actions.requestedAuthConfigs).toEqual({});
  });

  it('rejects an auth response that carried no refresh token', async () => {
    const manager = new BigQueryCredentialsManager(CLIENT_PAIR);
    const context = createToolContext({
      state: {[`temp:${BIGQUERY_CREDENTIAL_KEY}`]: authResponse({})},
    });

    await expect(manager.getValidCredentials(context)).rejects.toThrow(
      /The BigQuery authorization response must carry a clientId, a clientSecret and a refreshToken/,
    );
    expect(context.state.get(BIGQUERY_TOKEN_CACHE_KEY)).toBeUndefined();
  });
});
