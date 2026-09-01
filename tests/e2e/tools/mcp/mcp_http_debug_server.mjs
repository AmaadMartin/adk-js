/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real MCP server reachable over streamable HTTP, used by the debug-capture
 * e2e test. It listens on an ephemeral port and prints the port on stdout so
 * the test knows where to connect.
 *
 * The transport runs without a session id, and in that mode one transport
 * answers exactly one request, so each request gets its own server.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createServer} from 'node:http';

function createMcpServer() {
  const server = new McpServer({
    name: 'e2e-http-debug-server',
    version: '1.0.0',
  });
  server.registerTool(
    'echo',
    {description: 'the echo tool', inputSchema: {}},
    async () => ({content: [{type: 'text', text: 'echo'}]}),
  );
  return server;
}

const http = createServer(async (request, response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  response.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(request, response);
});

http.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${http.address().port}\n`);
});
