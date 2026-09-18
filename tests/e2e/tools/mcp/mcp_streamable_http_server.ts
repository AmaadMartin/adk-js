/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real MCP server over streamable HTTP, for the connection-options e2e test.
 *
 * It runs in-process on an ephemeral port and records every HTTP method it
 * receives, so a test can assert whether the client sent the session-ending
 * `DELETE`. The stdio fixture next to it spawns a child process because stdio
 * requires one; this transport does not.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';

/** A running MCP server, and what it saw. */
export interface StreamableHttpMcpServer {
  /** The MCP endpoint to point `StreamableHTTPConnectionParams.url` at. */
  url: string;
  /** HTTP methods the server received, in arrival order. */
  methods: string[];
  close(): Promise<void>;
}

export async function startStreamableHttpMcpServer(): Promise<StreamableHttpMcpServer> {
  const mcp = new McpServer({
    name: 'e2e-streamable-http-server',
    version: '1.0.0',
  });
  mcp.registerTool('ping', {description: 'Answers with pong.'}, async () => ({
    content: [{type: 'text', text: 'pong'}],
  }));

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  const methods: string[] = [];
  const http = createServer((req, res) => {
    methods.push(req.method ?? '');
    void transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => {
    http.listen(0, '127.0.0.1', resolve);
  });

  const {port} = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    methods,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
