/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPSessionManager} from '@google/adk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {randomUUID} from 'node:crypto';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {afterEach, describe, expect, it, vi} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPSessionManager` talks to real HTTP
 * servers on loopback. One server accepts the request and never answers it, the
 * other is a real MCP server over the Streamable HTTP transport. This proves
 * that `timeout`, `sseReadTimeout` and `terminateOnClose` change what happens on
 * the wire, not just what the unit test doubles record.
 */

const CONNECT_TIMEOUT_SECONDS = 1;
const STREAM_IDLE_TIMEOUT_SECONDS = 1;

/**
 * Budget for the reconnection case: the idle timeout plus the SDK's own
 * reconnection backoff (1s initial delay, growing by 1.5). Measured at ~2.0s.
 */
const RECONNECT_TEST_TIMEOUT_MS = 20000;

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

/** A real MCP server that records the HTTP method of every request it sees. */
async function startMcpServer(): Promise<TestMcpServer> {
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

describe('StreamableHTTPConnectionParams (e2e, real HTTP servers)', () => {
  let mcpServer: TestMcpServer | undefined;
  let silentServer: Server | undefined;

  afterEach(async () => {
    await mcpServer?.close();
    mcpServer = undefined;
    if (silentServer) await closeServer(silentServer);
    silentServer = undefined;
  });

  it('rejects session creation when the server never answers initialize', async () => {
    silentServer = createServer(() => {
      // Accept the connection and leave the request unanswered.
    });
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: await listen(silentServer),
      timeout: CONNECT_TIMEOUT_SECONDS,
    });

    const error = await manager.createSession().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Failed to create MCP session');
    expect((error as Error).message).toMatch(/timed out/i);
    expect(manager.getActiveSessions()).toEqual([]);
  });

  it('sends a DELETE carrying the session id when terminateOnClose is set', async () => {
    mcpServer = await startMcpServer();
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: mcpServer.url,
      terminateOnClose: true,
    });
    const client = await manager.createSession();
    expect(await client.listTools()).toHaveProperty('tools');

    await manager.closeSession(client);

    const deleted = mcpServer.requests.find((r) => r.method === 'DELETE');
    expect(deleted?.sessionId).toEqual(expect.any(String));
  });

  it('sends no DELETE when terminateOnClose is unset', async () => {
    mcpServer = await startMcpServer();
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: mcpServer.url,
    });
    const client = await manager.createSession();

    await manager.closeSession(client);

    expect(mcpServer.requests.map((r) => r.method)).not.toContain('DELETE');
  });

  it(
    'drops and reopens a silent event stream once sseReadTimeout elapses',
    async () => {
      mcpServer = await startMcpServer();
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: mcpServer.url,
        sseReadTimeout: STREAM_IDLE_TIMEOUT_SECONDS,
      });
      const client = await manager.createSession();
      const server = mcpServer;

      // The server never pushes on the standalone GET stream, so the idle
      // budget expires and the SDK reopens it.
      await vi.waitFor(
        () => {
          const gets = server.requests.filter((r) => r.method === 'GET');
          expect(gets.length).toBeGreaterThanOrEqual(2);
        },
        {timeout: RECONNECT_TEST_TIMEOUT_MS - 2000, interval: 100},
      );

      await manager.closeSession(client);
    },
    RECONNECT_TEST_TIMEOUT_MS,
  );
});
