/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal MCP server over stdio, used by real_mcp_server_test.ts.
 *
 * It serves one `echo` tool. The test launches this file with the current node
 * binary, so the client speaks to a real server process over a real transport.
 */

import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {name: 'echo-server', version: '1.0.0'},
  {capabilities: {tools: {}}},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes the message back.',
      inputSchema: {
        type: 'object',
        properties: {message: {type: 'string'}},
        required: ['message'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{type: 'text', text: `echo: ${request.params.arguments.message}`}],
}));

await server.connect(new StdioServerTransport());
