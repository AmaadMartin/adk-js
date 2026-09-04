/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-python resolves these credentials in `_google_credentials.py`, which
 * `tests/unittests/tools/data_agent/` does not cover. The port carries its own
 * manager, so it carries its own tests. The three validation messages are the
 * ones adk-python raises, verbatim.
 */

import {
  DATA_AGENT_DEFAULT_SCOPE,
  DATA_AGENT_TOKEN_CACHE_KEY,
  DataAgentCredentialsConfig,
} from '@google/adk';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';
// Not part of the public entry point: the toolset is the only caller, so the
// manager is imported from the source it lives in.
import {
  DataAgentAccessToken,
  DataAgentCredentialsManager,
  validateDataAgentCredentialsConfig,
} from '../../../src/tools/data_agent/credentials.js';
import {makeToolContext} from './data_agent_test_utils.js';

/** The bearer token an auth client presents, read back off the client. */
async function bearerOf(client: AuthClient | undefined): Promise<string> {
  if (!client) {
    return expect.fail('expected an auth client');
  }
  const headers = await client.getRequestHeaders('https://gda.test/v1');
  return headers.get('Authorization') ?? '';
}

/** A token that is valid for another hour. */
function freshToken(accessToken: string): DataAgentAccessToken {
  return {accessToken, expiresAt: Date.now() + 3_600_000};
}

describe('validateDataAgentCredentialsConfig', () => {
  it('accepts each of the three sources on its own', () => {
    const configs: DataAgentCredentialsConfig[] = [
      {credentials: new OAuth2Client()},
      {externalAccessTokenKey: 'token_key'},
      {clientId: 'abc', clientSecret: 'def'},
      {clientId: 'abc', clientSecret: 'def', scopes: ['scope']},
    ];
    for (const config of configs) {
      expect(() => validateDataAgentCredentialsConfig(config)).not.toThrow();
    }
  });

  it('refuses credentials alongside any other source', () => {
    expect(() =>
      validateDataAgentCredentialsConfig({
        credentials: new OAuth2Client(),
        clientId: 'abc',
      }),
    ).toThrow(
      'If credentials are provided, external_access_token_key, client_id,' +
        ' client_secret, and scopes must not be provided.',
    );
  });

  it('refuses an external token key alongside an OAuth client', () => {
    expect(() =>
      validateDataAgentCredentialsConfig({
        externalAccessTokenKey: 'token_key',
        clientSecret: 'def',
      }),
    ).toThrow(
      'If external_access_token_key is provided, client_id, client_secret,' +
        ' and scopes must not be provided.',
    );
  });

  it('refuses a config naming no source at all', () => {
    expect(() => validateDataAgentCredentialsConfig({clientId: 'abc'})).toThrow(
      'Must provide one of credentials, external_access_token_key, or' +
        ' client_id and client_secret pair.',
    );
  });
});

describe('DataAgentCredentialsManager', () => {
  it('hands back a configured client without a context', async () => {
    const credentials = new OAuth2Client();
    const manager = new DataAgentCredentialsManager({credentials});

    expect(await manager.getAuthClient()).toBe(credentials);
  });

  it('refuses to read session state without a context', async () => {
    const manager = new DataAgentCredentialsManager({
      externalAccessTokenKey: 'token_key',
    });

    await expect(manager.getAuthClient()).rejects.toThrow(
      'A tool context is required to resolve data agent credentials from' +
        ' session state. Call the tool through an agent.',
    );
  });

  it('builds a client from a token another component wrote to state', async () => {
    const context = makeToolContext();
    context.state.set('token_key', 'external-token');
    const manager = new DataAgentCredentialsManager({
      externalAccessTokenKey: 'token_key',
    });

    expect(await bearerOf(await manager.getAuthClient(context))).toBe(
      'Bearer external-token',
    );
  });

  it('reports an external token key that state does not hold', async () => {
    const manager = new DataAgentCredentialsManager({
      externalAccessTokenKey: 'token_key',
    });

    await expect(manager.getAuthClient(makeToolContext())).rejects.toThrow(
      'external_access_token_key is provided but no access token found in' +
        ' tool_context.state with key token_key.',
    );
  });

  it('asks for a credential and answers with nothing while the flow runs', async () => {
    const context = makeToolContext();
    const manager = new DataAgentCredentialsManager({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(await manager.getAuthClient(context)).toBeUndefined();
    expect(context.eventActions.requestedAuthConfigs['fc-1']).toBeDefined();
  });

  it('reuses a cached token instead of asking again', async () => {
    const context = makeToolContext();
    context.state.set(DATA_AGENT_TOKEN_CACHE_KEY, freshToken('cached-token'));
    const manager = new DataAgentCredentialsManager({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(await bearerOf(await manager.getAuthClient(context))).toBe(
      'Bearer cached-token',
    );
  });

  it('reuses a cached token that a refresh token can renew', async () => {
    const context = makeToolContext();
    context.state.set(DATA_AGENT_TOKEN_CACHE_KEY, {
      accessToken: 'stale-token',
      refreshToken: 'renew-me',
      expiresAt: Date.now() - 1000,
    });
    const manager = new DataAgentCredentialsManager({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(await manager.getAuthClient(context)).toBeDefined();
  });

  it('runs the flow again for a cached token that expired', async () => {
    const context = makeToolContext();
    context.state.set(DATA_AGENT_TOKEN_CACHE_KEY, {
      accessToken: 'stale-token',
      expiresAt: Date.now() - 1000,
    });
    const manager = new DataAgentCredentialsManager({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(await manager.getAuthClient(context)).toBeUndefined();
  });

  it('caches the token the completed flow returned', async () => {
    const context = makeToolContext();
    const manager = new DataAgentCredentialsManager({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: ['https://www.googleapis.com/auth/bigquery'],
    });
    // The first call asks for the credential; answering it in state is what
    // `context.getAuthResponse` reads on the second.
    await manager.getAuthClient(context);
    context.state.set(`temp:${DATA_AGENT_TOKEN_CACHE_KEY}`, {
      authType: 'oauth2',
      oauth2: {accessToken: 'granted-token', refreshToken: 'renew-me'},
    });

    expect(await bearerOf(await manager.getAuthClient(context))).toBe(
      'Bearer granted-token',
    );
    expect(context.state.get(DATA_AGENT_TOKEN_CACHE_KEY)).toEqual({
      accessToken: 'granted-token',
      refreshToken: 'renew-me',
      expiresAt: undefined,
    });
  });
});

describe('DATA_AGENT_DEFAULT_SCOPE', () => {
  it('asks for BigQuery, the scope a data agent reads through', () => {
    expect(DATA_AGENT_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigquery',
    ]);
  });
});
