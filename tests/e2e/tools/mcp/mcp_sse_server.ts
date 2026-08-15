/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real MCP server that speaks the HTTP+SSE transport over loopback, used by
 * the SSE e2e test. It streams messages on `GET /sse` and accepts client
 * messages on `POST /messages`, which is the transport pair `SseConnectionParams`
 * exists to reach.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import type {IncomingHttpHeaders, Server} from 'node:http';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {z} from 'zod';

const SSE_PATH = '/sse';
const MESSAGE_PATH = '/messages';

/** A running SSE server plus the request data the test asserts on. */
export interface SseTestServer {
  /** The SSE endpoint a client connects to. */
  url: string;
  /** Headers of every client POST, in arrival order. */
  postHeaders: IncomingHttpHeaders[];
  close(): Promise<void>;
}

/** Options controlling how the server answers the initial SSE request. */
export interface SseTestServerOptions {
  /** When set, `GET /sse` answers with this status instead of a stream. */
  rejectStreamWithStatus?: number;
}

function createMcpServer(): McpServer {
  const server = new McpServer({name: 'e2e-sse-server', version: '1.0.0'});
  server.registerTool(
    'echo',
    {description: 'Echoes the text back.', inputSchema: {text: z.string()}},
    ({text}) => ({content: [{type: 'text', text: `echo: ${text}`}]}),
  );
  return server;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Starts the server on an ephemeral loopback port. */
export async function startSseServer(
  options: SseTestServerOptions = {},
): Promise<SseTestServer> {
  const transports = new Map<string, SSEServerTransport>();
  const postHeaders: IncomingHttpHeaders[] = [];

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === SSE_PATH) {
      if (options.rejectStreamWithStatus !== undefined) {
        res.writeHead(options.rejectStreamWithStatus).end('stream refused');
        return;
      }
      // A fresh McpServer per stream: the SDK server owns one transport.
      const transport = new SSEServerTransport(MESSAGE_PATH, res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => {
        transports.delete(transport.sessionId);
      });
      void createMcpServer().connect(transport);
      return;
    }

    if (req.method === 'POST' && url.pathname === MESSAGE_PATH) {
      postHeaders.push(req.headers);
      const transport = transports.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) {
        res.writeHead(404).end('unknown session');
        return;
      }
      void transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404).end();
  });

  const port = await listen(http);

  return {
    url: `http://127.0.0.1:${port}${SSE_PATH}`,
    postHeaders,
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close();
      }
      transports.clear();
      // Streams that outlived their transport would keep `close` pending.
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
