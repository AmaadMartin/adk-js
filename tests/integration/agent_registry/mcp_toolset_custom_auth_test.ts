/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentRegistrySingleMCPToolset,
  AuthCredential,
  AuthCredentialTypes,
  BaseAuthProvider,
  CustomAuthConfig,
  registerAuthProvider,
} from '@google/adk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as http from 'node:http';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const TOKEN = 'e2e-static-token';

/** Authorization header values the live MCP server received, in order. */
const receivedAuthorization: Array<string | undefined> = [];

/** Mints one fixed bearer token, like a real provider fronting a token service. */
class StaticTokenAuthProvider implements BaseAuthProvider {
  readonly supportedAuthSchemes = ['e2eStaticTokenScheme'];

  async getAuthCredential(
    authConfig: CustomAuthConfig,
  ): Promise<AuthCredential> {
    return {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'Bearer',
        credentials: {token: `${TOKEN}-${authConfig.credentialKey}`},
      },
    };
  }
}

/** Stands in for a registered provider whose token service is unreachable. */
class FailingAuthProvider implements BaseAuthProvider {
  readonly supportedAuthSchemes = ['e2eFailingTokenScheme'];

  async getAuthCredential(): Promise<AuthCredential> {
    throw new Error('token service unreachable');
  }
}

describe('AgentRegistrySingleMCPToolset against a live MCP server', () => {
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    // Streamable HTTP in stateless mode: each request gets its own server and
    // transport, both closed once the response ends.
    server = http.createServer(async (req, res) => {
      receivedAuthorization.push(req.headers['authorization']);
      const mcpServer = new McpServer({name: 'auth-probe', version: '1.0.0'});
      mcpServer.registerTool(
        'ping',
        {description: 'Answers pong.'},
        async () => ({content: [{type: 'text', text: 'pong'}]}),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      expect.fail('the test MCP server did not bind a TCP port');
    }
    url = `http://127.0.0.1:${address.port}/mcp`;

    registerAuthProvider(new StaticTokenAuthProvider());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    receivedAuthorization.length = 0;
  });

  it('reaches the server with the provider credential', async () => {
    const toolset = new AgentRegistrySingleMCPToolset({
      connectionParams: {type: 'StreamableHTTPConnectionParams', url},
      destinationResourceId: 'projects/p/locations/l/mcpServers/probe',
      authScheme: {type: 'e2eStaticTokenScheme'},
    });

    const tools = await toolset.getTools();

    expect(tools.map((t) => t.name)).toEqual(['ping']);
    expect(receivedAuthorization.length).toBeGreaterThan(0);
    for (const value of receivedAuthorization) {
      expect(value).toBe(
        `Bearer ${TOKEN}-e2eStaticTokenScheme_projects/p/locations/l/mcpServers/probe`,
      );
    }
  });

  it('still lists tools with no header when the scheme has no provider', async () => {
    const toolset = new AgentRegistrySingleMCPToolset({
      connectionParams: {type: 'StreamableHTTPConnectionParams', url},
      authScheme: {type: 'e2eUnregisteredScheme'},
    });

    const tools = await toolset.getTools();

    expect(tools.map((t) => t.name)).toEqual(['ping']);
    expect(receivedAuthorization.length).toBeGreaterThan(0);
    for (const value of receivedAuthorization) {
      expect(value).toBeUndefined();
    }
  });

  it('lists tools with no header when the provider fails to mint', async () => {
    registerAuthProvider(new FailingAuthProvider());
    const toolset = new AgentRegistrySingleMCPToolset({
      connectionParams: {type: 'StreamableHTTPConnectionParams', url},
      authScheme: {type: 'e2eFailingTokenScheme'},
    });

    const tools = await toolset.getTools();

    expect(tools.map((t) => t.name)).toEqual(['ping']);
    expect(receivedAuthorization.length).toBeGreaterThan(0);
    for (const value of receivedAuthorization) {
      expect(value).toBeUndefined();
    }
  });
});
