/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing a single `search` tool over stdio. The
 * label passed as the first argument is echoed back in the tool result, so a
 * test can tell which server answered a call. Two instances are spawned by the
 * toolset prefix e2e test to create a tool name collision on purpose.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const label = process.argv[2];

const server = new McpServer({name: `e2e-${label}-server`, version: '1.0.0'});

server.registerTool(
  'search',
  {
    description: `Searches the ${label} corpus.`,
    inputSchema: {query: z.string()},
  },
  async ({query}) => ({
    content: [{type: 'text', text: `${label} answered ${query}`}],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
