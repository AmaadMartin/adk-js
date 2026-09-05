/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BIGQUERY_TOKEN_CACHE_KEY,
  BigQueryCredentialsConfig,
  BigQueryCredentialsManager,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  OAuth2Auth,
  PluginManager,
} from '@google/adk';
import {Credentials, OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';

const ONE_HOUR_MS = 3600 * 1000;

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** Builds a tool context backed by a real session and a real state object. */
function createToolContext(): Context {
  const session = createSession({id: 'test-session', appName: 'test-app'});
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: 'call-1'});
}

function createConfig(clientId = CLIENT_ID): BigQueryCredentialsConfig {
  return new BigQueryCredentialsConfig({
    clientId,
    clientSecret: CLIENT_SECRET,
    scopes: [CALENDAR_SCOPE],
  });
}

function createClient(credentials: Credentials): OAuth2Client {
  const client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  client.setCredentials(credentials);
  return client;
}

/**
 * Answers every token refresh with a new access token, so the test never
 * reaches Google's token endpoint. The manager builds its own client when it
 * rehydrates a cached token, so the seam has to be the prototype.
 */
function stubRefreshWith(accessToken: string) {
  return vi
    .spyOn(OAuth2Client.prototype, 'refreshAccessToken')
    .mockImplementation(async () => ({
      credentials: {
        access_token: accessToken,
        expiry_date: Date.now() + ONE_HOUR_MS,
      },
      res: null,
    }));
}

/** Answers every token refresh with the rejection a dead grant produces. */
function stubRefreshRejection() {
  return vi
    .spyOn(OAuth2Client.prototype, 'refreshAccessToken')
    .mockImplementation(() => Promise.reject(new Error('invalid_grant')));
}

/** Stores an OAuth response where `Context.getAuthResponse` reads it. */
function storeAuthResponse(
  toolContext: Context,
  credentialKey: string,
  oauth2: OAuth2Auth,
) {
  const credential: AuthCredential = {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2,
  };
  toolContext.state.set(`temp:${credentialKey}`, credential);
}

describe('BigQueryCredentialsManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a valid credential held by the config without touching state', async () => {
    const config = createConfig();
    config.credentials = createClient({
      access_token: 'access-token',
      expiry_date: Date.now() + ONE_HOUR_MS,
    });
    const toolContext = createToolContext();
    const getAuthResponse = vi.spyOn(toolContext, 'getAuthResponse');
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');
    const readState = vi.spyOn(toolContext.state, 'get');

    const result = await new BigQueryCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBe(config.credentials);
    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(requestCredential).not.toHaveBeenCalled();
    expect(readState).not.toHaveBeenCalled();
  });

  it('rehydrates a valid cached credential and keeps it on the config', async () => {
    const config = createConfig();
    const toolContext = createToolContext();
    toolContext.state.set(BIGQUERY_TOKEN_CACHE_KEY, {
      accessToken: 'cached-access-token',
      refreshToken: 'cached-refresh-token',
      expiresAt: Date.now() + ONE_HOUR_MS,
    } satisfies OAuth2Auth);
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    const result = await new BigQueryCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toEqual('cached-access-token');
    expect(config.credentials).toBe(result);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('requests authorization when neither the config nor the cache holds one', async () => {
    const toolContext = createToolContext();
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    const result = await new BigQueryCredentialsManager(
      createConfig(),
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('refreshes an expired cached credential', async () => {
    const config = createConfig();
    const toolContext = createToolContext();
    toolContext.state.set(BIGQUERY_TOKEN_CACHE_KEY, {
      accessToken: 'stale-access-token',
      refreshToken: 'cached-refresh-token',
      expiresAt: Date.now() - ONE_HOUR_MS,
    } satisfies OAuth2Auth);
    stubRefreshWith('refreshed-access-token');
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    const result = await new BigQueryCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toEqual('refreshed-access-token');
    expect(config.credentials).toBe(result);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('refreshes an expired credential held by the config', async () => {
    const config = createConfig();
    config.credentials = createClient({
      access_token: 'stale-access-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() - ONE_HOUR_MS,
    });
    const expired = config.credentials;
    const toolContext = createToolContext();
    stubRefreshWith('refreshed-access-token');

    const result = await new BigQueryCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBe(expired);
    expect(result?.credentials.access_token).toEqual('refreshed-access-token');
    expect(config.credentials).toBe(result);
  });

  it('requests authorization when the refresh is rejected', async () => {
    const config = createConfig();
    config.credentials = createClient({
      access_token: 'stale-access-token',
      refresh_token: 'revoked-refresh-token',
      expiry_date: Date.now() - ONE_HOUR_MS,
    });
    const toolContext = createToolContext();
    stubRefreshRejection();
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    const result = await new BigQueryCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('requests authorization when an expired credential cannot be refreshed', async () => {
    const config = createConfig();
    config.credentials = createClient({
      access_token: 'stale-access-token',
      expiry_date: Date.now() - ONE_HOUR_MS,
    });
    const toolContext = createToolContext();
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    const result = await new BigQueryCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result).toBeUndefined();
    expect(requestCredential).toHaveBeenCalledTimes(1);
  });

  it('completes the flow and caches the tokens without the client secret', async () => {
    const config = createConfig();
    const toolContext = createToolContext();
    storeAuthResponse(toolContext, `bigquery_oauth_${CLIENT_ID}`, {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    const result = await new BigQueryCredentialsManager(
      config,
    ).getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toEqual('new-access-token');
    expect(result?.credentials.refresh_token).toEqual('new-refresh-token');
    expect(config.credentials).toBe(result);
    expect(requestCredential).not.toHaveBeenCalled();
    expect(toolContext.state.get(BIGQUERY_TOKEN_CACHE_KEY)).toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: undefined,
    });
  });

  it('shares the cached token with a second manager over the same config', async () => {
    const config = createConfig();
    const toolContext = createToolContext();
    storeAuthResponse(toolContext, `bigquery_oauth_${CLIENT_ID}`, {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    await new BigQueryCredentialsManager(config).getValidCredentials(
      toolContext,
    );

    const second = createConfig();
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');
    const result = await new BigQueryCredentialsManager(
      second,
    ).getValidCredentials(toolContext);

    expect(result?.credentials.access_token).toEqual('new-access-token');
    expect(second.credentials).toBe(result);
    expect(requestCredential).not.toHaveBeenCalled();
  });

  it('asks for authorization with both Google endpoints and every scope', async () => {
    const toolContext = createToolContext();
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    await new BigQueryCredentialsManager(createConfig()).getValidCredentials(
      toolContext,
    );

    const authConfig = requestCredential.mock.calls[0][0];
    const authScheme = authConfig.authScheme;
    if (authScheme.type !== 'oauth2') {
      expect.fail(`expected an oauth2 scheme, got ${authScheme.type}`);
    }
    expect(authScheme.flows.authorizationCode).toEqual({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: {[CALENDAR_SCOPE]: `Access to ${CALENDAR_SCOPE}`},
    });
    expect(authConfig.rawAuthCredential?.oauth2).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(authConfig.credentialKey).toEqual(`bigquery_oauth_${CLIENT_ID}`);
  });

  it('keeps two client ids on separate credential keys', async () => {
    const toolContext = createToolContext();
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    await new BigQueryCredentialsManager(
      createConfig('client-one'),
    ).getValidCredentials(toolContext);
    await new BigQueryCredentialsManager(
      createConfig('client-two'),
    ).getValidCredentials(toolContext);

    expect(requestCredential.mock.calls[0][0].credentialKey).toEqual(
      'bigquery_oauth_client-one',
    );
    expect(requestCredential.mock.calls[1][0].credentialKey).toEqual(
      'bigquery_oauth_client-two',
    );
  });
});
