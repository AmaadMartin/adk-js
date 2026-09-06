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
  InvocationContext,
  PluginManager,
  createSession,
  isFunctionTool,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';

/** An OAuth2 client config, as adk-python's tests configure BigQuery. */
const OAUTH_OPTIONS = {
  clientId: 'test_client_id',
  clientSecret: 'test_client_secret',
  scopes: ['https://www.googleapis.com/auth/bigquery'],
};

/** The parameters a Google API function declares to receive both injections. */
const SAMPLE_PARAMETERS = z.object({
  param1: z.string(),
  credentials: z.custom<AuthClient>().optional(),
  settings: z.custom<Record<string, unknown>>().optional(),
});

function makeContext(state: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 's1', appName: 'app', userId: 'u1', state}),
      pluginManager: new PluginManager([]),
    }),
    functionCallId: 'fc-1',
  });
}

function makeCredentials(): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({access_token: 'test_access_token'});
  return client;
}

function makeCredentialsConfig(): BaseGoogleCredentialsConfig {
  return new BaseGoogleCredentialsConfig(OAUTH_OPTIONS);
}

/**
 * Stubs credential resolution, as adk-python's tests patch
 * `GoogleCredentialsManager.get_valid_credentials`.
 */
function stubCredentials(credentials: AuthClient | undefined) {
  return vi
    .spyOn(GoogleCredentialsManager.prototype, 'getValidCredentials')
    .mockResolvedValue(credentials);
}

describe('GoogleTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs a function tool that hides the injected parameters', () => {
    const tool = new GoogleTool({
      name: 'sample_func',
      description: 'A sample Google API tool.',
      parameters: SAMPLE_PARAMETERS,
      credentialsConfig: makeCredentialsConfig(),
      execute: () => ({result: 'ok'}),
    });

    expect(isFunctionTool(tool)).toBe(true);
    const properties = tool._getDeclaration().parameters?.properties;
    expect(properties).toBeDefined();
    expect(Object.keys(properties ?? {})).toEqual(['param1']);
  });

  it('requests no authorization when no credentials config is given', async () => {
    let receivedCredentials: AuthClient | undefined;
    const tool = new GoogleTool({
      name: 'sample_func',
      description: 'A sample Google API tool.',
      parameters: SAMPLE_PARAMETERS,
      execute: ({credentials}) => {
        receivedCredentials = credentials;
        return {result: 'ok'};
      },
    });
    const toolContext = makeContext();

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext,
    });

    expect(result).toEqual({result: 'ok'});
    expect(receivedCredentials).toBeUndefined();
    expect(toolContext.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('runs a synchronous function with the resolved credentials', async () => {
    const credentials = makeCredentials();
    const getValidCredentials = stubCredentials(credentials);
    const tool = new GoogleTool({
      name: 'sample_func',
      description: 'A sample Google API tool.',
      parameters: SAMPLE_PARAMETERS,
      credentialsConfig: makeCredentialsConfig(),
      execute: (args) => ({
        result: `Success with ${args.param1}`,
        authenticated: args.credentials === credentials,
      }),
    });
    const toolContext = makeContext();

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext,
    });

    expect(getValidCredentials).toHaveBeenCalledTimes(1);
    expect(getValidCredentials).toHaveBeenCalledWith(toolContext);
    expect(result).toEqual({
      result: 'Success with test_value',
      authenticated: true,
    });
  });

  it('runs an asynchronous function with the resolved credentials', async () => {
    const credentials = makeCredentials();
    stubCredentials(credentials);
    const tool = new GoogleTool({
      name: 'async_sample_func',
      description: 'An async Google API tool.',
      parameters: SAMPLE_PARAMETERS,
      credentialsConfig: makeCredentialsConfig(),
      execute: async (args) => ({
        result: `Async success with ${args.param1}`,
        authenticated: args.credentials === credentials,
      }),
    });

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: makeContext(),
    });

    expect(result).toEqual({
      result: 'Async success with test_value',
      authenticated: true,
    });
  });

  it('returns the authorization message while consent is in flight', async () => {
    stubCredentials(undefined);
    const execute = vi.fn(() => ({result: 'ok'}));
    const tool = new GoogleTool({
      name: 'sample_func',
      description: 'A sample Google API tool.',
      parameters: SAMPLE_PARAMETERS,
      credentialsConfig: makeCredentialsConfig(),
      execute,
    });

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: makeContext(),
    });

    expect(result).toBe(
      'User authorization is required to access Google services for' +
        ' sample_func. Please complete the authorization flow.',
    );
    expect(result).toContain(tool.name);
    expect(execute).not.toHaveBeenCalled();
  });

  it('injects an undefined credential when no manager is configured', async () => {
    const tool = new GoogleTool({
      name: 'sample_func',
      description: 'A sample Google API tool.',
      parameters: SAMPLE_PARAMETERS,
      execute: (args) => ({
        result: `Success with ${args.param1}`,
        authenticated: args.credentials !== undefined,
      }),
    });

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: makeContext(),
    });

    expect(result).toEqual({
      result: 'Success with test_value',
      authenticated: false,
    });
  });

  it('returns a structured error when the function throws', async () => {
    stubCredentials(makeCredentials());
    const tool = new GoogleTool({
      name: 'failing_function',
      description: 'A Google API tool that fails.',
      parameters: SAMPLE_PARAMETERS,
      credentialsConfig: makeCredentialsConfig(),
      execute: () => {
        throw new Error('Something went wrong');
      },
    });

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: makeContext(),
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect((result as {error_details: string}).error_details).toContain(
      'Something went wrong',
    );
  });

  it('keeps the injected parameters out of the declaration', () => {
    const tool = new GoogleTool({
      name: 'complex_function',
      description: 'A Google API tool with several parameters.',
      parameters: z.object({
        requiredParam: z.string(),
        optionalParam: z.string().optional(),
        credentials: z.custom<AuthClient>().optional(),
        settings: z.custom<Record<string, unknown>>().optional(),
      }),
      credentialsConfig: makeCredentialsConfig(),
      execute: () => ({success: true}),
    });

    const parameters = tool._getDeclaration().parameters;
    expect(Object.keys(parameters?.properties ?? {})).toEqual([
      'requiredParam',
      'optionalParam',
    ]);
    expect(parameters?.required).toEqual(['requiredParam']);
  });

  it('passes the configured tool settings to the function', async () => {
    const toolSettings = {maxQueryResultRows: 50, writeMode: 'blocked'};
    let receivedSettings: unknown;
    const tool = new GoogleTool({
      name: 'settings_function',
      description: 'A Google API tool that reads its settings.',
      parameters: SAMPLE_PARAMETERS,
      toolSettings,
      execute: (args) => {
        receivedSettings = args.settings;
        return {success: true};
      },
    });

    await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: makeContext(),
    });

    expect(receivedSettings).toBe(toolSettings);
  });

  it('injects nothing into a function that declares neither parameter', async () => {
    stubCredentials(makeCredentials());
    let receivedKeys: string[] = [];
    const tool = new GoogleTool({
      name: 'strict_function',
      description: 'A Google API tool with a strict schema.',
      parameters: z.object({city: z.string()}).strict(),
      credentialsConfig: makeCredentialsConfig(),
      toolSettings: {maxRows: 10},
      execute: (args) => {
        receivedKeys = Object.keys(args);
        return {success: true};
      },
    });

    const result = await tool.runAsync({
      args: {city: 'Paris'},
      toolContext: makeContext(),
    });

    expect(result).toEqual({success: true});
    expect(receivedKeys).toEqual(['city']);
  });

  it('drops an injected parameter the model supplied', async () => {
    const credentials = makeCredentials();
    stubCredentials(credentials);
    const toolSettings = {maxRows: 10};
    let received: {credentials?: AuthClient; settings?: unknown} = {};
    const tool = new GoogleTool({
      name: 'spoofable_function',
      description: 'A Google API tool the model may try to spoof.',
      parameters: SAMPLE_PARAMETERS,
      credentialsConfig: makeCredentialsConfig(),
      toolSettings,
      execute: (args) => {
        received = args;
        return {success: true};
      },
    });

    const result = await tool.runAsync({
      args: {
        param1: 'Paris',
        credentials: 'spoofed_credentials',
        settings: 'spoofed_settings',
      },
      toolContext: makeContext(),
    });

    expect(result).toEqual({success: true});
    expect(received.credentials).toBe(credentials);
    expect(received.settings).toBe(toolSettings);
  });

  it('drops a spoofed argument the schema does not reject', async () => {
    stubCredentials(makeCredentials());
    let receivedKeys: string[] = [];
    const tool = new GoogleTool({
      name: 'passthrough_function',
      description: 'A Google API tool with a permissive schema.',
      parameters: z.object({city: z.string()}).passthrough(),
      credentialsConfig: makeCredentialsConfig(),
      toolSettings: {maxRows: 10},
      execute: (args) => {
        receivedKeys = Object.keys(args);
        return {success: true};
      },
    });

    const result = await tool.runAsync({
      args: {
        city: 'Paris',
        credentials: 'spoofed_credentials',
        settings: 'spoofed_settings',
      },
      toolContext: makeContext(),
    });

    expect(result).toEqual({success: true});
    expect(receivedKeys).toEqual(['city']);
  });

  it('returns a structured error when credential resolution fails', async () => {
    const tool = new GoogleTool({
      name: 'external_token_function',
      description: 'A Google API tool using an external access token.',
      parameters: SAMPLE_PARAMETERS,
      credentialsConfig: new BaseGoogleCredentialsConfig({
        externalAccessTokenKey: 'access_token_key',
      }),
      execute: () => ({success: true}),
    });

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: makeContext(),
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect((result as {error_details: string}).error_details).toContain(
      'externalAccessTokenKey',
    );
  });

  it('asks the end user for consent when no credential is cached', async () => {
    const tool = new GoogleTool({
      name: 'consent_function',
      description: 'A Google API tool that needs consent.',
      parameters: SAMPLE_PARAMETERS,
      credentialsConfig: makeCredentialsConfig(),
      execute: () => ({success: true}),
    });
    const toolContext = makeContext();
    const requestCredential = vi.spyOn(toolContext, 'requestCredential');

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext,
    });

    expect(requestCredential).toHaveBeenCalledTimes(1);
    expect(toolContext.eventActions.requestedAuthConfigs['fc-1']).toBeDefined();
    expect(result).toBe(
      'User authorization is required to access Google services for' +
        ' consent_function. Please complete the authorization flow.',
    );
  });

  it('reports TOOL_ERROR only for an error response', () => {
    const tool = new GoogleTool({
      name: 'detector_function',
      description: 'A Google API tool.',
      execute: () => ({success: true}),
    });

    expect(
      tool.detectErrorInResponse({status: 'ERROR', error_details: 'x'}),
    ).toBe('TOOL_ERROR');
    for (const response of [
      {status: 'OK'},
      {},
      null,
      undefined,
      'a string',
      42,
    ]) {
      expect(tool.detectErrorInResponse(response)).toBeUndefined();
    }
  });

  it('does not mutate a schema the caller owns', () => {
    const parameters: Schema = {
      type: Type.OBJECT,
      properties: {
        city: {type: Type.STRING},
        credentials: {type: Type.OBJECT},
        settings: {type: Type.OBJECT},
      },
      required: ['city', 'credentials'],
    };
    const tool = new GoogleTool({
      name: 'schema_function',
      description: 'A Google API tool declared with a raw schema.',
      parameters,
      execute: () => ({success: true}),
    });

    const declared = tool._getDeclaration().parameters;

    expect(Object.keys(declared?.properties ?? {})).toEqual(['city']);
    expect(declared?.required).toEqual(['city']);
    expect(Object.keys(parameters.properties ?? {})).toEqual([
      'city',
      'credentials',
      'settings',
    ]);
    expect(parameters.required).toEqual(['city', 'credentials']);
  });
});
