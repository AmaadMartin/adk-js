/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  InvocationContext,
  MCPToolset,
  PluginManager,
  createSession,
} from '@google/adk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Progress} from '@modelcontextprotocol/sdk/types.js';
import {createServer, type IncomingHttpHeaders, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks over real HTTP to a
 * real MCP server running in this process. It proves that a resolved API key
 * and the headers a provider adds both reach the wire, and that a progress
 * notification the server sends reaches the configured callback.
 */

/** Every HTTP request the server received, newest last. */
const receivedHeaders: IncomingHttpHeaders[] = [];

const API_KEY = 'e2e-api-key';
const API_KEY_HEADER = 'X-Api-Key';
const TENANT_HEADER = 'X-Tenant-Id';
const TENANT_ID = 'tenant-42';

let server: Server;
let url: string;

/** Builds the MCP server that answers one stateless HTTP request. */
function buildMcpServer(): McpServer {
  const mcpServer = new McpServer({name: 'e2e-auth-server', version: '1.0.0'});

  mcpServer.registerTool(
    'echo',
    {
      description: 'Echoes the message back.',
      inputSchema: {message: z.string()},
    },
    async ({message}) => ({content: [{type: 'text', text: message}]}),
  );

  mcpServer.registerTool(
    'count',
    {description: 'Reports progress, then finishes.', inputSchema: {}},
    async (_args, extra) => {
      const progressToken = extra._meta?.progressToken;
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {progressToken, progress: 1, total: 2},
        });
      }
      return {content: [{type: 'text', text: 'done'}]};
    },
  );

  return mcpServer;
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'e2e-invocation',
      session: createSession({id: 'e2e-session', appName: 'e2e-app'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'e2e-call',
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    receivedHeaders.push(req.headers);
    const mcpServer = buildMcpServer();
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

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const {port} = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

afterEach(() => {
  receivedHeaders.length = 0;
});

describe('MCPTool authentication (e2e, real MCP server over HTTP)', () => {
  it('sends both the API key and the provider headers on the tool call', async () => {
    const toolset = new MCPToolset(
      {type: 'StreamableHTTPConnectionParams', url},
      [],
      undefined,
      {
        authScheme: {type: 'apiKey', in: 'header', name: API_KEY_HEADER},
        authCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: API_KEY,
        },
        headerProvider: async () => ({[TENANT_HEADER]: TENANT_ID}),
      },
    );

    const tools = await toolset.getTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    if (!echo) {
      expect.fail('the server did not advertise the echo tool');
    }
    receivedHeaders.length = 0;

    const result = await echo.runAsync({
      args: {message: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({content: [{type: 'text', text: 'hello'}]});
    const headers = receivedHeaders.at(-1);
    expect(headers?.[API_KEY_HEADER.toLowerCase()]).toBe(API_KEY);
    expect(headers?.[TENANT_HEADER.toLowerCase()]).toBe(TENANT_ID);
    await toolset.close();
  });

  it('sends no credential header when the toolset configures none', async () => {
    const toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url,
    });

    const tools = await toolset.getTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    if (!echo) {
      expect.fail('the server did not advertise the echo tool');
    }
    receivedHeaders.length = 0;

    await echo.runAsync({
      args: {message: 'hello'},
      toolContext: createToolContext(),
    });

    expect(receivedHeaders.at(-1)).not.toHaveProperty(
      API_KEY_HEADER.toLowerCase(),
    );
    await toolset.close();
  });

  it('reports the progress the server sends during a call', async () => {
    const reported: Progress[] = [];
    const toolset = new MCPToolset(
      {type: 'StreamableHTTPConnectionParams', url},
      [],
      undefined,
      {progressCallback: (progress) => reported.push(progress)},
    );

    const tools = await toolset.getTools();
    const count = tools.find((tool) => tool.name === 'count');
    if (!count) {
      expect.fail('the server did not advertise the count tool');
    }

    await count.runAsync({args: {}, toolContext: createToolContext()});

    expect(reported).toMatchObject([{progress: 1, total: 2}]);
    await toolset.close();
  });
});
