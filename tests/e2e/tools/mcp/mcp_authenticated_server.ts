/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real MCP server over streamable HTTP that requires an API key header.
 *
 * A request without the header gets 401, so a test using this server proves
 * that the header a toolset builds actually reaches an MCP server.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import {randomUUID} from 'node:crypto';
import {IncomingMessage, ServerResponse, createServer} from 'node:http';
import {AddressInfo} from 'node:net';
import {z} from 'zod';

/** The header the server reads the key from, lower-cased as Node delivers it. */
const API_KEY_HEADER = 'x-api-key';

/** The key the server accepts. A test fixture, not a real credential. */
export const API_KEY = 'e2e-secret-key';

/** A running MCP server and the way to shut it down. */
export interface AuthenticatedMcpServer {
  url: string;
  close: () => Promise<void>;
}

/** Builds the MCP server exposing the single `echo` tool. */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'e2e-authenticated-server',
    version: '1.0.0',
  });
  server.registerTool(
    'echo',
    {description: 'Echoes its input.', inputSchema: {text: z.string()}},
    ({text}) => ({content: [{type: 'text' as const, text}]}),
  );
  return server;
}

/** Reads a JSON request body, or undefined when there is none. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Starts the server on an ephemeral port and waits until it accepts requests.
 *
 * Each MCP session gets its own transport, so a client may connect, close and
 * connect again — which is what a toolset does, one session per operation.
 */
export async function startAuthenticatedMcpServer(): Promise<AuthenticatedMcpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers[API_KEY_HEADER] !== API_KEY) {
      res.writeHead(401, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'missing or wrong API key'}));
      return;
    }

    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    const sessionId = req.headers['mcp-session-id'];
    let transport =
      typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(body)) {
      const created: StreamableHTTPServerTransport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            transports.set(id, created);
          },
        });
      await createMcpServer().connect(created);
      transport = created;
    }

    if (!transport) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'unknown MCP session'}));
      return;
    }
    await transport.handleRequest(req, res, body);
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'server failure'}));
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const {port} = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await Promise.all([...transports.values()].map((t) => t.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
