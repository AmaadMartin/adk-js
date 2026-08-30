/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing two tools over stdio: one backed by an
 * MCP App (it declares a `ui://` resource in its `_meta`) and one plain tool.
 * The MCPTool widget e2e test spawns it as a child process to exercise the
 * widget path against an actual MCP server, with no mocks.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const server = new McpServer({name: 'e2e-mcp-app-server', version: '1.0.0'});

server.registerTool(
  'render_chart',
  {
    description: 'Renders a chart in an MCP App.',
    inputSchema: {series: z.array(z.number())},
    _meta: {ui: {resourceUri: 'ui://charts/bar'}},
  },
  async ({series}) => ({
    content: [{type: 'text', text: `charted ${series.length} points`}],
  }),
);

server.registerTool(
  'sum',
  {
    description: 'Adds two numbers, with no UI.',
    inputSchema: {a: z.number(), b: z.number()},
  },
  async ({a, b}) => ({content: [{type: 'text', text: String(a + b)}]}),
);

const transport = new StdioServerTransport();
await server.connect(transport);
