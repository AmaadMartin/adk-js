/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  BasePlugin,
  Context,
  GoogleCredentialsManager,
  GoogleTool,
  GoogleToolAuth,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
  functionsExportedForTestingOnly,
} from '@google/adk';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';
import {withGoogleCredentials} from '../../src/tools/google_tool.js';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

/** Records the error the framework reports to a plugin. */
class RecordingErrorPlugin extends BasePlugin {
  seen?: Error;

  override async onToolErrorCallback(params: {
    error: Error;
  }): Promise<undefined> {
    this.seen = params.error;
    return undefined;
  }
}

function makeContext(state: Record<string, unknown> = {}): Context {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u1',
    state,
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: 'fc-1'});
}

/** A config resolving to the access token the host application put in state. */
function externalTokenConfig(): BaseGoogleCredentialsConfig {
  return new BaseGoogleCredentialsConfig({
    externalAccessTokenKey: 'access_token',
  });
}

/** A config that always starts a fresh OAuth flow, so no credential resolves. */
function oauthConfig(): BaseGoogleCredentialsConfig {
  return new BaseGoogleCredentialsConfig({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    scopes: ['https://www.googleapis.com/auth/spanner.data'],
  });
}

describe('GoogleTool credential injection', () => {
  it('passes the resolved credential to the wrapped function', async () => {
    let received: AuthClient | undefined;
    const tool = new GoogleTool({
      name: 'list_databases',
      description: 'Lists Spanner databases.',
      parameters: z.object({instanceId: z.string()}),
      credentialsConfig: externalTokenConfig(),
      execute: (input, auth: GoogleToolAuth) => {
        received = auth.credentials;
        return `listed ${input.instanceId}`;
      },
    });

    const result = await tool.runAsync({
      args: {instanceId: 'inst-1'},
      toolContext: makeContext({access_token: 'external-token'}),
    });

    expect(result).toBe('listed inst-1');
    expect(received?.credentials.access_token).toBe('external-token');
  });

  it('asks the user to authorize when no credential resolves', async () => {
    let ran = false;
    const tool = new GoogleTool({
      name: 'list_databases',
      description: 'Lists Spanner databases.',
      credentialsConfig: oauthConfig(),
      execute: () => {
        ran = true;
        return 'listed';
      },
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: makeContext(),
    });

    expect(result).toBe(
      'User authorization is required to access Google services for ' +
        'list_databases. Please complete the authorization flow.',
    );
    expect(ran).toBe(false);
  });

  it('runs without a credential when no credentials config is given', async () => {
    let received: GoogleToolAuth | undefined;
    const tool = new GoogleTool({
      name: 'ping',
      description: 'Pings.',
      execute: (_input, auth: GoogleToolAuth) => {
        received = auth;
        return 'pong';
      },
    });

    const result = await tool.runAsync({args: {}, toolContext: makeContext()});

    expect(result).toBe('pong');
    expect(received?.credentials).toBeUndefined();
  });

  it('lets the wrapped function close over its toolset settings', async () => {
    const settings = {maxRows: 50};
    let received = 0;
    const tool = new GoogleTool({
      name: 'query',
      description: 'Runs a query.',
      execute: () => {
        received = settings.maxRows;
        return 'queried';
      },
    });

    await tool.runAsync({args: {}, toolContext: makeContext()});

    expect(received).toBe(50);
  });
});

describe('GoogleTool error reporting', () => {
  it('propagates a failure of the wrapped function', async () => {
    const tool = new GoogleTool({
      name: 'query',
      description: 'Runs a query.',
      execute: () => {
        throw new Error('table not found');
      },
    });

    await expect(
      tool.runAsync({args: {}, toolContext: makeContext()}),
    ).rejects.toThrow('table not found');
  });

  it('propagates a failure of credential resolution', async () => {
    const tool = new GoogleTool({
      name: 'query',
      description: 'Runs a query.',
      credentialsConfig: externalTokenConfig(),
      execute: () => 'queried',
    });

    await expect(
      tool.runAsync({args: {}, toolContext: makeContext()}),
    ).rejects.toThrow(
      'externalAccessTokenKey is provided but no access token found',
    );
  });

  it('reaches the plugin tool-error callback when the function fails', async () => {
    const plugin = new RecordingErrorPlugin('recorder');
    const tool = new GoogleTool({
      name: 'query',
      description: 'Runs a query.',
      execute: () => {
        throw new Error('table not found');
      },
    });
    const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
    const invocationContext = new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
      session,
      pluginManager: new PluginManager([plugin]),
    });

    await handleFunctionCallList({
      invocationContext,
      functionCalls: [{id: 'fc-1', name: 'query', args: {}}],
      toolsDict: {'query': tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    expect(plugin.seen?.message).toContain('table not found');
  });

  it('needs a tool context to resolve credentials', async () => {
    const execute = withGoogleCredentials(
      () => 'queried',
      new GoogleCredentialsManager(externalTokenConfig()),
      'query',
    );

    await expect(execute('', undefined)).rejects.toThrow(
      "Tool 'query' needs a tool context to resolve credentials.",
    );
  });
});

describe('GoogleTool declaration and construction', () => {
  it('declares only the model-facing parameters', () => {
    const tool = new GoogleTool({
      name: 'list_databases',
      description: 'Lists Spanner databases.',
      parameters: z.object({instanceId: z.string()}),
      credentialsConfig: externalTokenConfig(),
      execute: () => 'listed',
    });

    const declaration = tool._getDeclaration();

    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'instanceId',
    ]);
  });

  it('names the tool after the execute function when no name is given', () => {
    const tool = new GoogleTool({
      description: 'Lists Spanner databases.',
      execute: function listDatabases() {
        return 'listed';
      },
    });

    expect(tool.name).toBe('listDatabases');
  });

  it('prefers an explicit name over the execute function name', () => {
    const tool = new GoogleTool({
      name: 'list_databases',
      description: 'Lists Spanner databases.',
      execute: function listDatabases() {
        return 'listed';
      },
    });

    expect(tool.name).toBe('list_databases');
  });

  it('rejects an anonymous execute function with no name', () => {
    // A function returned from a call carries no inferred name, unlike one
    // written directly as a property value.
    const makeExecute = () => () => 'listed';

    expect(
      () =>
        new GoogleTool({
          description: 'Lists Spanner databases.',
          execute: makeExecute(),
        }),
    ).toThrow('Tool name cannot be empty');
  });
});

describe('GoogleTool inherited confirmation gate', () => {
  it('requests confirmation before resolving credentials or running', async () => {
    let ran = false;
    const context = makeContext();
    const tool = new GoogleTool({
      name: 'drop_database',
      description: 'Drops a database.',
      credentialsConfig: oauthConfig(),
      requireConfirmation: true,
      execute: () => {
        ran = true;
        return 'dropped';
      },
    });

    const result = await tool.runAsync({args: {}, toolContext: context});

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(ran).toBe(false);
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });
});

describe('GoogleTool with a pre-built client', () => {
  it('hands an application-supplied client to the function', async () => {
    const client = new OAuth2Client();
    client.setCredentials({
      access_token: 'service-account-token',
      expiry_date: Date.now() + 60 * 60 * 1000,
    });
    let received: AuthClient | undefined;
    const tool = new GoogleTool({
      name: 'query',
      description: 'Runs a query.',
      credentialsConfig: new BaseGoogleCredentialsConfig({
        credentials: client,
      }),
      execute: (_input, auth: GoogleToolAuth) => {
        received = auth.credentials;
        return 'queried';
      },
    });

    const result = await tool.runAsync({args: {}, toolContext: makeContext()});

    expect(result).toBe('queried');
    expect(received).toBe(client);
  });
});
