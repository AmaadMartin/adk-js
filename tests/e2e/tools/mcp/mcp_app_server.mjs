/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP App server exposing one tool over streamable HTTP. The
 * tool declares a `ui://` resource in its `_meta`, so the MCPTool e2e test can
 * exercise the widget push and the HTTP debug capture against an actual server.
 *
 * It runs stateless, and the SDK's streamable-HTTP transport refuses to serve a
 * second request in that mode, so each request gets its own server and
 * transport.
 *
 * It listens on an ephemeral port and prints `LISTENING <port>` on stdout.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {createServer} from 'node:http';

function createMcpServer() {
  const server = new McpServer({name: 'e2e-app-server', version: '1.0.0'});
  server.registerTool(
    'weather',
    {
      description: 'Reports the weather.',
      inputSchema: {},
      _meta: {ui: {resourceUri: 'ui://weather-app'}},
    },
    async () => ({content: [{type: 'text', text: 'sunny'}]}),
  );
  return server;
}

const http = createServer(async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

http.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${http.address().port}\n`);
});
