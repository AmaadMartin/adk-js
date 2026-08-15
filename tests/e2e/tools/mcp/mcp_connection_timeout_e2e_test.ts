/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPSessionManager, MCPToolset} from '@google/adk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {randomUUID} from 'node:crypto';
import type {IncomingMessage, Server, ServerResponse} from 'node:http';
import {createServer} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` and `MCPSessionManager`
 * talk to a real MCP server over the Streamable HTTP transport on loopback.
 * This proves that `timeout` and `terminateOnClose` change what happens on the
 * wire, not just what a test double records.
 */

const ROUND_TRIP_TIMEOUT_MS = 1000;

/** Long enough that a loopback round trip never reaches it. */
const GENEROUS_TIMEOUT_MS = 30000;

interface RecordedRequest {
  method: string;
  sessionId?: string;
}

interface TestMcpServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/** Binds `server` to an ephemeral loopback port and returns its MCP URL. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    expect.fail('the test server did not bind a TCP port');
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  req.setEncoding('utf8');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

/** Reports whether `body` is a JSON-RPC message naming `method`. */
function isJsonRpcMethod(body: unknown, method: string): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'method' in body &&
    body.method === method
  );
}

/**
 * A real MCP server that records the HTTP method of every request it sees.
 *
 * A request for `stalledMethod` is accepted and never answered, which is how a
 * server that outruns the caller's deadline behaves.
 */
async function startMcpServer(stalledMethod?: string): Promise<TestMcpServer> {
  const mcp = new McpServer({name: 'e2e-timeout-server', version: '1.0.0'});
  mcp.registerTool('ping', {description: 'Returns pong.'}, () => ({
    content: [{type: 'text', text: 'pong'}],
  }));

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  const requests: RecordedRequest[] = [];

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    requests.push({
      method: req.method ?? '',
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    });
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    if (stalledMethod !== undefined && isJsonRpcMethod(body, stalledMethod)) {
      return;
    }
    await transport.handleRequest(req, res, body);
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    url: await listen(server),
    requests,
    close: async () => {
      await transport.close();
      await closeServer(server);
    },
  };
}

describe('MCP connection timeout options (e2e, a real HTTP MCP server)', () => {
  let mcpServer: TestMcpServer | undefined;
  let silentServer: Server | undefined;

  afterEach(async () => {
    await mcpServer?.close();
    mcpServer = undefined;
    if (silentServer) await closeServer(silentServer);
    silentServer = undefined;
  });

  it('lists tools over a real session when the server answers in time', async () => {
    mcpServer = await startMcpServer();
    const toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: mcpServer.url,
      timeout: GENEROUS_TIMEOUT_MS,
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['ping']);
  });

  it('rejects a tool listing that outruns the configured deadline', async () => {
    mcpServer = await startMcpServer('tools/list');
    const toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: mcpServer.url,
      timeout: ROUND_TRIP_TIMEOUT_MS,
    });

    await expect(toolset.getTools()).rejects.toThrow(
      'MCP listTools timed out after 1000ms',
    );
  });

  it('rejects session creation when the server never answers initialize', async () => {
    silentServer = createServer(() => {
      // Accept the connection and leave the request unanswered.
    });
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: await listen(silentServer),
      timeout: ROUND_TRIP_TIMEOUT_MS,
    });

    const error = await manager.createSession().catch((e: unknown) => e);

    if (!(error instanceof Error)) {
      expect.fail('createSession resolved instead of rejecting');
    }
    expect(error.message).toContain('Failed to create MCP session');
    expect(error.message).toMatch(/timed out/i);
    expect(manager.getActiveSessions()).toEqual([]);
  });

  it('sends a DELETE carrying the session id when the session closes', async () => {
    mcpServer = await startMcpServer();
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: mcpServer.url,
    });
    const client = await manager.createSession();

    await manager.closeSession(client);

    const deleted = mcpServer.requests.find((r) => r.method === 'DELETE');
    expect(deleted?.sessionId).toEqual(expect.any(String));
  });

  it('sends no DELETE when terminateOnClose is false', async () => {
    mcpServer = await startMcpServer();
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: mcpServer.url,
      terminateOnClose: false,
    });
    const client = await manager.createSession();

    await manager.closeSession(client);

    expect(mcpServer.requests.map((r) => r.method)).not.toContain('DELETE');
  });
});
