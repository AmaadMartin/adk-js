/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing two MCP-App tools over stdio. `echo`
 * declares a `_meta.ui` block, so the metadata accessors run against a real
 * listing. `crash` exits the process without answering, so the client sees a
 * real transport crash. Neither test mocks anything.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const server = new McpServer({name: 'e2e-mcp-app-server', version: '1.0.0'});

server.registerTool(
  'echo',
  {
    description: 'Echoes the message back.',
    inputSchema: {message: z.string()},
    _meta: {
      ui: {
        resourceUri: 'ui://widget/echo',
      },
    },
  },
  async ({message}) => ({content: [{type: 'text', text: message}]}),
);

server.registerTool(
  'crash',
  {
    description: 'Exits the server process without answering the call.',
    inputSchema: {},
  },
  async () => {
    process.exit(1);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
