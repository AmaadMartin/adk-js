/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  MCPToolset,
  PluginManager,
  createSession,
} from '@google/adk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createServer, type IncomingMessage, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks over real HTTP to a
 * real MCP server. Calling `stall` makes the server open the event stream and
 * then destroy the socket without answering, which is the transport failure
 * the MCP SDK only reports to `transport.onerror`. Without the guard the call
 * waits out the SDK's 60-second request timeout; the test's own timeout is far
 * shorter, so a regression fails here rather than hanging.
 */

/** How long the tool call may take before the test calls it a stall. */
const GUARD_TIMEOUT_MS = 10_000;

/** How long the server holds the event stream open before dropping it. */
const STREAM_OPEN_MS = 250;

let server: Server;
let url: string;

function buildMcpServer(): McpServer {
  const mcpServer = new McpServer({name: 'e2e-guard-server', version: '1.0.0'});

  mcpServer.registerTool(
    'stall',
    {description: 'Never answers.', inputSchema: {}},
    async () => ({content: [{type: 'text', text: 'unreachable'}]}),
  );

  return mcpServer;
}

/** Reads a request body without consuming it for the MCP transport. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/** Whether the body is the `tools/call` for the stalling tool. */
function isStallCall(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const message = body as {method?: string; params?: {name?: string}};
  return message.method === 'tools/call' && message.params?.name === 'stall';
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
    const body = await readBody(req);

    if (isStallCall(body)) {
      // Open the event stream, then drop the connection without a response.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write(': open\n\n');
      // Let the client receive the response and start reading the stream, so
      // the failure lands on the open stream rather than on the POST itself.
      setTimeout(() => res.socket?.destroy(), STREAM_OPEN_MS);
      return;
    }

    const mcpServer = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
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

describe('MCPTool transport guard (e2e, real MCP server over HTTP)', () => {
  it(
    'reports a lost connection instead of waiting for the request timeout',
    async () => {
      const toolset = new MCPToolset({
        type: 'StreamableHTTPConnectionParams',
        url,
      });
      const tools = await toolset.getTools();
      const stall = tools.find((tool) => tool.name === 'stall');
      if (!stall) {
        expect.fail('the server did not advertise the stall tool');
      }

      const startedAt = Date.now();
      await expect(
        stall.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(/MCP session connection lost/);
      expect(Date.now() - startedAt).toBeLessThan(GUARD_TIMEOUT_MS);

      await toolset.close();
    },
    GUARD_TIMEOUT_MS,
  );
});
