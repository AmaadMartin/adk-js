/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  BaseAgent,
  Context,
  InvocationContext,
  MCPToolset,
  PluginManager,
  createSession,
  type AuthScheme,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

import {
  API_KEY,
  AuthenticatedMcpServer,
  startAuthenticatedMcpServer,
} from './mcp_authenticated_server.js';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` reaches a real MCP server
 * over HTTP that answers 401 without an API key header. It proves the header
 * built from the exchanged credential arrives at the server.
 */

const apiKeyScheme: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

/** A real tool context; the MCP tool call needs one to run. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-e2e-auth',
      agent: {} as BaseAgent,
      session: createSession({id: 'session-e2e-auth', appName: 'app'}),
      pluginManager: new PluginManager(),
      abortSignal: new AbortController().signal,
    }),
  });
}

describe('MCPToolset authentication (e2e, real MCP server over HTTP)', () => {
  let toolset: MCPToolset | undefined;
  let server: AuthenticatedMcpServer | undefined;

  /** Starts the server and points a toolset at it. */
  async function connect(withCredential: boolean): Promise<MCPToolset> {
    server = await startAuthenticatedMcpServer();
    const created = new MCPToolset({
      connectionParams: {
        type: 'StreamableHTTPConnectionParams',
        url: server.url,
      },
      authScheme: apiKeyScheme,
    });
    toolset = created;

    if (withCredential) {
      const authConfig = created.getAuthConfig();
      if (!authConfig) {
        expect.fail('an auth scheme was configured, so getAuthConfig is set');
      }
      authConfig.exchangedAuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: API_KEY,
      };
    }
    return created;
  }

  afterEach(async () => {
    await toolset?.close();
    await server?.close();
    toolset = undefined;
    server = undefined;
  });

  it('lists the server tools once the credential is exchanged', async () => {
    const authenticated = await connect(true);

    const tools = await authenticated.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('the discovered tool reaches the server with the same credential', async () => {
    const authenticated = await connect(true);

    const [echo] = await authenticated.getTools();
    const result = await echo.runAsync({
      args: {text: 'hello'},
      toolContext: createToolContext(),
    });

    expect(JSON.stringify(result)).toContain('hello');
  });

  it('fails against the same server without the credential', async () => {
    const unauthenticated = await connect(false);

    await expect(unauthenticated.getTools()).rejects.toThrow();
  });
});
