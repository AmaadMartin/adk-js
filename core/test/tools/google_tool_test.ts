/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  Context,
  GoogleCredentialsManager,
  GoogleTool,
  GoogleToolExecuteContext,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {Type} from '@google/genai';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';

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

    expect(typeof result).toBe('string');
    expect(String(result).toLowerCase()).toContain('authorization is required');
    expect(String(result)).toContain('list_datasets');
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

    expect(result).toMatchObject({status: 'ERROR'});
    expect(String((result as {error_details: string}).error_details)).toContain(
      'Something went wrong',
    );
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

  it('keeps the injected parameters out of the declaration', () => {
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          requiredParam: {type: Type.STRING},
          optionalParam: {type: Type.STRING},
          credentials: {type: Type.STRING},
          settings: {type: Type.STRING},
        },
        required: ['requiredParam', 'credentials', 'settings'],
      },
      credentialsConfig: credentialsConfig(),
      execute: () => 'ok',
    });

    const {properties, required} = tool._getDeclaration().parameters ?? {};

    expect(Object.keys(properties ?? {})).toEqual([
      'requiredParam',
      'optionalParam',
    ]);
    expect(required).toEqual(['requiredParam']);
  });

  it('keeps a declaration without properties or required intact', () => {
    const tool = new GoogleTool({
      name: 'ping',
      description: 'Pings the API.',
      parameters: {type: Type.OBJECT},
      execute: () => 'ok',
    });

    const parameters = tool._getDeclaration().parameters;

    expect(parameters?.type).toBe(Type.OBJECT);
    expect(parameters?.properties).toBeUndefined();
    expect(parameters?.required).toBeUndefined();
  });

  it('strips injected parameters the model supplied', async () => {
    const client = authorizedClient();
    stubResolvedCredentials(client);
    let receivedInput: unknown;
    let receivedCredentials: unknown;
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      credentialsConfig: credentialsConfig(),
      execute: (input, _toolContext, google) => {
        receivedInput = input;
        receivedCredentials = google?.credentials;
        return 'ok';
      },
    });

    await tool.runAsync({
      args: {
        requiredParam: 'x',
        credentials: 'injected',
        settings: 'injected',
      },
      toolContext,
    });

    expect(receivedInput).toEqual({requiredParam: 'x'});
    expect(receivedCredentials).toBe(client);
  });

  it('reports an error response to telemetry as TOOL_ERROR', () => {
    const tool = new GoogleTool({
      name: 'list_datasets',
      description: 'Lists BigQuery datasets.',
      execute: () => 'ok',
    });

    expect(tool.detectErrorInResponse({status: 'ERROR'})).toBe('TOOL_ERROR');
    expect(tool.detectErrorInResponse({status: 'OK'})).toBeUndefined();
    expect(tool.detectErrorInResponse({})).toBeUndefined();
    expect(tool.detectErrorInResponse('ERROR')).toBeUndefined();
    expect(tool.detectErrorInResponse(null)).toBeUndefined();
    expect(tool.detectErrorInResponse(undefined)).toBeUndefined();
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
