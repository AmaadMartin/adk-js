/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server over StreamableHTTP, exposing one `whoami` tool
 * that echoes back the `authorization` request header it received. The MCP auth
 * e2e test starts it in-process to prove that a credential configured on an
 * MCPToolset reaches the server with no mocks in between.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {AddressInfo} from 'node:net';

/** A running echo server and the handle needed to shut it down. */
export interface AuthEchoServer {
  /** The MCP endpoint to point a connection at. */
  url: string;
  /** Stops the HTTP listener and the MCP server. */
  close: () => Promise<void>;
}

/**
 * Starts the echo server on an ephemeral port.
 *
 * @return The running server.
 */
export async function startAuthEchoServer(): Promise<AuthEchoServer> {
  const http = createServer((req, res) => {
    // A stateless MCP server holds no state between requests, so each request
    // gets its own server and transport, torn down when the response ends.
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => {
    http.listen(0, '127.0.0.1', resolve);
  });
  const {port} = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Serves one MCP request with a throwaway server and transport. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = new McpServer({name: 'e2e-auth-server', version: '1.0.0'});
  server.registerTool(
    'whoami',
    {description: 'Returns the authorization header the server received.'},
    (extra) => {
      const authorization = extra.requestInfo?.headers['authorization'];
      return {
        content: [
          {
            type: 'text' as const,
            text: Array.isArray(authorization)
              ? authorization.join(', ')
              : (authorization ?? 'none'),
          },
        ],
      };
    },
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}
