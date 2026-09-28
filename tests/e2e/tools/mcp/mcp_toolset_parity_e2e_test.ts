/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  AuthScheme,
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  MCPToolset,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {randomUUID} from 'node:crypto';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * over real HTTP on localhost. The server counts the `tools/list` round trips it
 * serves and records the headers it receives, so the tool-list cache and the
 * auth and tenant headers are checked against what actually went on the wire.
 */

/** Requests the server has served, in order, with the headers they carried. */
interface ServedRequest {
  method: string;
  headers: Record<string, string>;
}

const served: ServedRequest[] = [];
const transports = new Map<string, StreamableHTTPServerTransport>();
let httpServer: Server;
let baseUrl: string;

function buildMcpServer(): McpServer {
  const server = new McpServer({name: 'e2e-parity-server', version: '1.0.0'});

  server.registerTool(
    'zebra',
    {description: 'Returns the argument it was given.', inputSchema: {}},
    async () => ({content: [{type: 'text', text: 'zebra ran'}]}),
  );
  server.registerTool(
    'alpha',
    {description: 'Reports that it ran.', inputSchema: {}},
    async () => ({content: [{type: 'text', text: 'alpha ran'}]}),
  );
  server.registerResource(
    'readme',
    'file:///readme.txt',
    {mimeType: 'text/plain'},
    async (uri) => ({
      contents: [
        {uri: uri.href, mimeType: 'text/plain', text: 'hello over http'},
      ],
    }),
  );

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Records the JSON-RPC method and headers of one incoming request. */
function record(req: IncomingMessage, body: unknown): void {
  const calls = Array.isArray(body) ? body : [body];
  for (const call of calls) {
    const method =
      call && typeof call === 'object' && 'method' in call
        ? String((call as {method: unknown}).method)
        : 'unknown';
    served.push({
      method,
      headers: req.headers as Record<string, string>,
    });
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  if (req.method !== 'POST') {
    const existing =
      typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (!existing) {
      res.writeHead(400).end();
      return;
    }
    return existing.handleRequest(req, res);
  }

  const body = await readBody(req);
  record(req, body);

  if (typeof sessionId === 'string') {
    const existing = transports.get(sessionId);
    if (!existing) {
      res.writeHead(404).end();
      return;
    }
    return existing.handleRequest(req, res, body);
  }

  const transport: StreamableHTTPServerTransport =
    new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport);
      },
    });
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
    }
  };
  await buildMcpServer().connect(transport);
  return transport.handleRequest(req, res, body);
}

function invocationContext(state: Record<string, unknown>): InvocationContext {
  return new InvocationContext({
    invocationId: 'e2e-invocation',
    agent: new LlmAgent({name: 'e2e_agent', model: 'gemini-2.0-flash'}),
    session: createSession({
      id: 'e2e-session',
      appName: 'e2e-app',
      userId: 'e2e-user',
      state,
    }),
    pluginManager: new PluginManager([]),
    sessionService: new InMemorySessionService(),
  });
}

function readonlyContext(state: Record<string, unknown> = {}): ReadonlyContext {
  return new ReadonlyContext(invocationContext(state));
}

function toolContext(): Context {
  return new Context({
    invocationContext: invocationContext({}),
    functionCallId: 'e2e-function-call-id',
  });
}

const bearerScheme: AuthScheme = {type: 'http', scheme: 'bearer'};

/** How many `tools/list` round trips the server has served. */
function listCount(): number {
  return served.filter((entry) => entry.method === 'tools/list').length;
}

describe('MCPToolset (e2e, real MCP server over HTTP)', () => {
  let toolset: MCPToolset | undefined;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', resolve),
    );
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
    served.length = 0;
  });

  it('discovers the real tools, sorted by name, and runs one', async () => {
    toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: baseUrl,
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['alpha', 'zebra']);
    const result = await tools[0].runAsync({
      args: {},
      toolContext: toolContext(),
    });
    expect(result).toMatchObject({content: [{text: 'alpha ran'}]});
  });

  it('makes one tools/list round trip across two getTools calls', async () => {
    toolset = new MCPToolset(
      {type: 'StreamableHTTPConnectionParams', url: baseUrl},
      [],
      undefined,
      {
        toolListCacheTtlSeconds: 30,
      },
    );

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(listCount()).toBe(1);
    expect(second.map((tool) => tool.name)).toEqual(
      first.map((tool) => tool.name),
    );
  });

  it('sends the auth header and the provider header on the wire', async () => {
    toolset = new MCPToolset(
      {type: 'StreamableHTTPConnectionParams', url: baseUrl},
      [],
      undefined,
      {
        authScheme: bearerScheme,
        headerProvider: (context) => ({
          'X-Tenant-ID': String(context.state.get('tenant')),
        }),
      },
    );
    const authConfig = toolset.getAuthConfig();
    if (!authConfig) {
      expect.fail('the toolset built no auth config');
    }
    authConfig.exchangedAuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'e2e-access-token'},
    };

    await toolset.getTools(readonlyContext({tenant: 'tenant-42'}));

    const listRequest = served.find((entry) => entry.method === 'tools/list');
    if (!listRequest) {
      expect.fail('the server served no tools/list request');
    }
    expect(listRequest.headers['authorization']).toBe(
      'Bearer e2e-access-token',
    );
    expect(listRequest.headers['x-tenant-id']).toBe('tenant-42');
  });

  it('keeps one cache entry per tenant', async () => {
    let tenant = 'tenant-a';
    toolset = new MCPToolset(
      {type: 'StreamableHTTPConnectionParams', url: baseUrl},
      [],
      undefined,
      {
        toolListCacheTtlSeconds: 30,
        headerProvider: () => ({'X-Tenant-ID': tenant}),
      },
    );
    const context = readonlyContext({});

    await toolset.getTools(context);
    tenant = 'tenant-b';
    await toolset.getTools(context);
    tenant = 'tenant-a';
    await toolset.getTools(context);

    expect(listCount()).toBe(2);
  });

  it('exposes load_mcp_resource and reads a real resource with it', async () => {
    toolset = new MCPToolset(
      {type: 'StreamableHTTPConnectionParams', url: baseUrl},
      [],
      undefined,
      {useMcpResources: true},
    );

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'alpha',
      'zebra',
      'load_mcp_resource',
    ]);
    const contents = await toolset.readResource('readme');
    expect(contents[0]).toMatchObject({text: 'hello over http'});
  });
});
