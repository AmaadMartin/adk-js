/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server that advertises both tools and a resource over
 * stdio. It is spawned as a child process by the `useMcpResources` e2e test to
 * prove, with no mocks, that MCPToolset.getTools() appends a real
 * `load_mcp_resource` tool after the discovered tools when the flag is set.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({name: 'e2e-toolset-server', version: '1.0.0'});

server.registerTool(
  'echo',
  {description: 'Echoes a fixed message.'},
  async () => ({content: [{type: 'text', text: 'echo'}]}),
);

server.registerTool('ping', {description: 'Replies with pong.'}, async () => ({
  content: [{type: 'text', text: 'pong'}],
}));

server.registerResource(
  'readme',
  'file:///readme.txt',
  {mimeType: 'text/plain'},
  async (uri) => ({
    contents: [
      {uri: uri.href, mimeType: 'text/plain', text: 'hello from mcp resource'},
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
