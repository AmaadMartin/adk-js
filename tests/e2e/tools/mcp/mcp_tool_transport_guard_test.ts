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
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';

/**
 * End-to-end tests with NO mocks: a real `MCPToolset` talks over real HTTP to
 * a real MCP server, driving the MCP SDK into two states that look alike on
 * the error channel and must not be treated alike.
 *
 * `stall` opens the event stream, sends a priming event so the SDK treats the
 * stream as resumable, then destroys the socket without answering. Every
 * resume fails, the SDK gives up, and nothing closes the transport, so the
 * call would otherwise wait out the SDK's 60-second request timeout.
 *
 * `echo` runs against the same server, which refuses the optional standalone
 * GET stream with 404. The SDK reports that as a transport error too, but the
 * session is healthy and the call must succeed. A POST-only gateway behaves
 * exactly like this, so failing here would break a supported deployment.
 */

/** How long a call may take before the test calls it a stall. */
const GUARD_TIMEOUT_MS = 15_000;

/** How long the server holds the event stream open before dropping it. */
const STREAM_OPEN_MS = 150;

let server: Server;
let url: string;

function buildMcpServer(): McpServer {
  const mcpServer = new McpServer({name: 'e2e-guard-server', version: '1.0.0'});

  mcpServer.registerTool(
    'echo',
    {
      description: 'Echoes the message back.',
      inputSchema: {message: z.string()},
    },
    async ({message}) => ({content: [{type: 'text', text: message}]}),
  );

  mcpServer.registerTool(
    'stall',
    {description: 'Never answers.', inputSchema: {}},
    async () => ({content: [{type: 'text', text: 'unreachable'}]}),
  );

  return mcpServer;
}

/** Reads a request body so the handler can route on it. */
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

/**
 * Answers with a resumable event stream, then drops it without a response.
 *
 * The `id` on the priming event is what makes the SDK treat the stream as
 * resumable, so it runs its whole reconnection ladder before giving up.
 */
function dropStreamAfterPrimingEvent(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  res.write('id: 1\ndata: \n\n');
  setTimeout(() => res.socket?.destroy(), STREAM_OPEN_MS);
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
    // The optional standalone stream, and every resume attempt, are refused.
    if (req.method === 'GET') {
      res.writeHead(404).end();
      return;
    }

    const body = await readBody(req);
    if (isStallCall(body)) {
      dropStreamAfterPrimingEvent(res);
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
  it('answers normally when the server refuses the optional GET stream', async () => {
    const toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url,
    });
    const tools = await toolset.getTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    if (!echo) {
      expect.fail('the server did not advertise the echo tool');
    }

    const result = await echo.runAsync({
      args: {message: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({content: [{type: 'text', text: 'hello'}]});
    await toolset.close();
  });

  it(
    'reports a lost connection once the SDK stops resuming the stream',
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
