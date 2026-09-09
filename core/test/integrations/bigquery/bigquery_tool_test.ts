/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BIGQUERY_TOKEN_CACHE_KEY,
  BigQueryCredentialsConfig,
  BigQueryTool,
  BigQueryToolErrorResponse,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  OAuth2Auth,
  PluginManager,
} from '@google/adk';
import {OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const ONE_HOUR_MS = 3600 * 1000;

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';

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

function createConfig(): BigQueryCredentialsConfig {
  return new BigQueryCredentialsConfig({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
}

/** Puts a usable credential in the session-state cache. */
function cacheValidToken(toolContext: Context) {
  toolContext.state.set(`${BIGQUERY_TOKEN_CACHE_KEY}_${CLIENT_ID}`, {
    accessToken: 'cached-access-token',
    expiresAt: Date.now() + ONE_HOUR_MS,
  } satisfies OAuth2Auth);
}

const listDatasetsParameters = z.object({projectId: z.string()});

describe('BigQueryTool', () => {
  it('builds a credentials manager when a config is given', () => {
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists datasets.',
      credentials: createConfig(),
      execute: () => 'ok',
    });

    expect(tool.credentialsManager).toBeDefined();
  });

  it('builds no credentials manager when no config is given', () => {
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists datasets.',
      execute: () => 'ok',
    });

    expect(tool.credentialsManager).toBeUndefined();
  });

  it('hands the resolved credential to the function', async () => {
    const toolContext = createToolContext();
    cacheValidToken(toolContext);
    let received: OAuth2Client | undefined;
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists datasets.',
      parameters: listDatasetsParameters,
      credentials: createConfig(),
      execute: (input, credentials) => {
        received = credentials;
        return {datasets: [input.projectId]};
      },
    });

    const result = await tool.runAsync({
      args: {projectId: 'my-project'},
      toolContext,
    });

    expect(received?.credentials.access_token).toEqual('cached-access-token');
    expect(result).toEqual({datasets: ['my-project']});
  });

  it('asks the user to authorize while the flow is pending', async () => {
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists datasets.',
      credentials: createConfig(),
      execute: () => 'never runs',
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual(
      'User authorization is required to access Google services for ' +
        'list_datasets. Please complete the authorization flow.',
    );
  });

  it('runs the function with no credential when no config is given', async () => {
    let received: OAuth2Client | undefined = new OAuth2Client();
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists datasets.',
      execute: (input, credentials) => {
        received = credentials;
        return 'ran';
      },
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(received).toBeUndefined();
    expect(result).toEqual('ran');
  });

  it('awaits an async function', async () => {
    const toolContext = createToolContext();
    cacheValidToken(toolContext);
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists datasets.',
      credentials: createConfig(),
      execute: async (input, credentials) => {
        await Promise.resolve();
        return {authenticated: credentials !== undefined};
      },
    });

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({authenticated: true});
  });

  it('reports a thrown error as a structured payload', async () => {
    const toolContext = createToolContext();
    cacheValidToken(toolContext);
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists datasets.',
      credentials: createConfig(),
      execute: () => {
        throw new Error('Something went wrong');
      },
    });

    const result = (await tool.runAsync({
      args: {},
      toolContext,
    })) as BigQueryToolErrorResponse;

    expect(result.status).toEqual('ERROR');
    expect(result.error_details).toContain('Something went wrong');
  });

  it('reports a rejected promise as a structured payload', async () => {
    const toolContext = createToolContext();
    cacheValidToken(toolContext);
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists datasets.',
      credentials: createConfig(),
      execute: () => Promise.reject(new Error('BigQuery is unreachable')),
    });

    const result = (await tool.runAsync({
      args: {},
      toolContext,
    })) as BigQueryToolErrorResponse;

    expect(result.status).toEqual('ERROR');
    expect(result.error_details).toContain('BigQuery is unreachable');
  });

  it('keeps the credential out of the declaration the model sees', () => {
    const tool = new BigQueryTool({
      name: 'complex_tool',
      description: 'Takes two parameters.',
      parameters: z.object({
        requiredParam: z.string(),
        optionalParam: z.string().optional(),
      }),
      credentials: createConfig(),
      execute: () => 'ok',
    });

    const declaration = tool._getDeclaration();

    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'requiredParam',
      'optionalParam',
    ]);
    expect(declaration.parameters?.required).toEqual(['requiredParam']);
    expect(JSON.stringify(declaration)).not.toContain('credentials');
  });

  it('names the tool after the function, not the credential wrapper', () => {
    function listDatasets() {
      return 'ok';
    }

    const tool = new BigQueryTool({
      description: 'Lists datasets.',
      credentials: createConfig(),
      execute: listDatasets,
    });

    expect(tool.name).toEqual('listDatasets');
  });

  it('rejects a tool with neither a name nor a named function', () => {
    // A function returned from a call carries no inferred name, where one
    // written inline as `execute:` would be named after the property.
    const anonymous = [() => 'ok'][0];

    expect(
      () =>
        new BigQueryTool({
          description: 'Lists datasets.',
          credentials: createConfig(),
          execute: anonymous,
        }),
    ).toThrow('Tool name cannot be empty');
  });
});
