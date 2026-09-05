/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  GoogleTool,
  GoogleToolExecuteContext,
  GoogleToolStatus,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';
// Not part of the package barrel: `GoogleTool` is the public surface.
import {
  BaseGoogleCredentialsConfig,
  GoogleCredentialsManager,
} from '../../src/tools/google_credentials.js';
import {
  authorizationRequiredMessage,
  withGoogleCredentials,
} from '../../src/tools/google_tool.js';

const CLIENT_ID = 'test_client_id';
const CLIENT_SECRET = 'test_client_secret';
const SCOPES = ['https://www.googleapis.com/auth/bigquery'];
const HOUR_MS = 60 * 60 * 1000;

interface BigQuerySettings {
  writeMode: string;
  maxQueryResultRows: number;
}

interface SpannerSettings {
  maxExecutedQueryResultRows: number;
}

function makeContext(): Context {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: 'fc-1'});
}

function credentialsConfig(): BaseGoogleCredentialsConfig {
  return new BaseGoogleCredentialsConfig({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: SCOPES,
  });
}

function authorizedClient(): OAuth2Client {
  const client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  client.setCredentials({
    access_token: 'valid_token',
    expiry_date: Date.now() + HOUR_MS,
  });
  return client;
}

/** Makes every credentials manager resolve to `client` for this test. */
function stubResolvedCredentials(client: OAuth2Client | undefined) {
  return vi
    .spyOn(GoogleCredentialsManager.prototype, 'getValidCredentials')
    .mockResolvedValue(client);
}

describe('GoogleTool', () => {
  let toolContext: Context;

  beforeEach(() => {
    vi.restoreAllMocks();
    toolContext = makeContext();
  });

  it('returns the authorization prompt while the OAuth flow is pending', async () => {
    const execute = vi.fn(() => ({result: 'never reached'}));
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      credentialsConfig: credentialsConfig(),
      execute,
    });

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe(authorizationRequiredMessage('list_datasets'));
    expect(String(result).toLowerCase()).toContain('authorization is required');
    expect(execute).not.toHaveBeenCalled();
    expect(toolContext.eventActions.requestedAuthConfigs['fc-1']).toBeDefined();
  });

  it('runs without a credentials config and injects no credential', async () => {
    let received: GoogleToolExecuteContext<unknown> | undefined;
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      execute: (_input, _toolContext, google) => {
        received = google;
        return {result: 'Success', authenticated: Boolean(google?.credentials)};
      },
    });

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({result: 'Success', authenticated: false});
    expect(received?.credentials).toBeUndefined();
  });

  it('hands a resolved credential to the wrapped function', async () => {
    const client = authorizedClient();
    stubResolvedCredentials(client);
    let received: AuthClient | undefined;
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      parameters: z.object({param1: z.string()}),
      credentialsConfig: credentialsConfig(),
      execute: (input, _toolContext, google) => {
        received = google?.credentials;
        return {result: `Success with ${input.param1}`};
      },
    });

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext,
    });

    expect(result).toEqual({result: 'Success with test_value'});
    expect(received).toBe(client);
  });

  it('awaits an async function rather than returning its promise', async () => {
    stubResolvedCredentials(authorizedClient());
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      parameters: z.object({param1: z.string()}),
      credentialsConfig: credentialsConfig(),
      execute: async (input) => ({
        result: `Async success with ${input.param1}`,
      }),
    });

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext,
    });

    expect(result).toEqual({result: 'Async success with test_value'});
  });

  it('returns an error response when the wrapped function throws', async () => {
    stubResolvedCredentials(authorizedClient());
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      credentialsConfig: credentialsConfig(),
      execute: () => {
        throw new Error('Something went wrong');
      },
    });

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({
      status: GoogleToolStatus.ERROR,
      error_details: "Error in tool 'list_datasets': Something went wrong",
    });
  });

  it('returns an error response when resolving the credential throws', async () => {
    vi.spyOn(
      GoogleCredentialsManager.prototype,
      'getValidCredentials',
    ).mockRejectedValue(new Error('no access token in state'));
    const execute = vi.fn(() => ({result: 'never reached'}));
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      credentialsConfig: credentialsConfig(),
      execute,
    });

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toMatchObject({status: 'ERROR'});
    expect(String((result as {error_details: string}).error_details)).toContain(
      'no access token in state',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns an error response when the arguments fail validation', async () => {
    stubResolvedCredentials(authorizedClient());
    const execute = vi.fn(() => ({result: 'never reached'}));
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      parameters: z.object({param1: z.string()}),
      credentialsConfig: credentialsConfig(),
      execute,
    });

    const result = await tool.runAsync({args: {param1: 42}, toolContext});

    expect(result).toMatchObject({status: 'ERROR'});
    expect(execute).not.toHaveBeenCalled();
  });

  it('hands the BigQuery-shaped settings to the wrapped function', async () => {
    stubResolvedCredentials(authorizedClient());
    const settings: BigQuerySettings = {
      writeMode: 'blocked',
      maxQueryResultRows: 50,
    };
    let received: BigQuerySettings | undefined;
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      credentialsConfig: credentialsConfig(),
      toolSettings: settings,
      execute: (_input, _toolContext, google) => {
        received = google?.settings;
        return 'ok';
      },
    });

    await tool.runAsync({args: {}, toolContext});

    expect(received).toBe(settings);
  });

  it('hands the Spanner-shaped settings to the wrapped function', async () => {
    const settings: SpannerSettings = {maxExecutedQueryResultRows: 10};
    let received: SpannerSettings | undefined;
    const tool = new GoogleTool({
      name: 'execute_sql',
      description: 'Runs a Spanner query.',
      toolSettings: settings,
      execute: (_input, _toolContext, google) => {
        received = google?.settings;
        return 'ok';
      },
    });

    await tool.runAsync({args: {}, toolContext});

    expect(received).toBe(settings);
  });

  it('hands the tool context to the wrapped function', async () => {
    let received: Context | undefined;
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      execute: (_input, callContext) => {
        received = callContext;
        return 'ok';
      },
    });

    await tool.runAsync({args: {}, toolContext});

    expect(received?.userId).toBe('u1');
  });

  it('declares only the parameters the caller asked for', () => {
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      parameters: z.object({projectId: z.string()}),
      credentialsConfig: credentialsConfig(),
      toolSettings: {maxQueryResultRows: 50},
      execute: () => 'ok',
    });

    const {properties, required} = tool._getDeclaration().parameters ?? {};

    expect(Object.keys(properties ?? {})).toEqual(['projectId']);
    expect(required).toEqual(['projectId']);
  });

  it('ignores a credential the model invented', async () => {
    const client = authorizedClient();
    stubResolvedCredentials(client);
    let receivedCredentials: unknown;
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      credentialsConfig: credentialsConfig(),
      execute: (_input, _toolContext, google) => {
        receivedCredentials = google?.credentials;
        return 'ok';
      },
    });

    await tool.runAsync({
      args: {credentials: 'injected', settings: 'injected'},
      toolContext,
    });

    expect(receivedCredentials).toBe(client);
  });

  it('names the tool after the wrapped function when no name is given', () => {
    const tool = new GoogleTool({
      description: 'Lists BigQuery datasets.',
      execute: function myTool() {
        return 'ok';
      },
    });

    expect(tool.name).toBe('myTool');
  });

  it('rejects a tool with neither a name nor a named function', () => {
    // An arrow function returned from a call carries no inferred name, unlike
    // one written directly as the `execute` property.
    const anonymous = (
      () => () =>
        'ok'
    )();

    expect(
      () =>
        new GoogleTool({
          description: 'Lists BigQuery datasets.',
          execute: anonymous,
        }),
    ).toThrow('Tool name cannot be empty');
  });
});

describe('withGoogleCredentials', () => {
  it('rejects a credentialed call that carries no tool context', async () => {
    const execute = vi.fn(() => 'ok');
    const adapter = withGoogleCredentials(execute, {
      name: 'list_datasets',
      credentialsManager: new GoogleCredentialsManager(credentialsConfig()),
    });

    await expect(adapter('', undefined)).rejects.toThrow(
      "Tool 'list_datasets' needs a tool context to resolve credentials.",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
