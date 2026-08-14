/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing one tool over stdio. Every process
 * appends its pid to the file named by `MCP_PID_FILE`, so the session pooling
 * e2e test can count how many server processes the toolset started.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {appendFileSync} from 'node:fs';

appendFileSync(process.env.MCP_PID_FILE, `${process.pid}\n`);

const server = new McpServer({name: 'e2e-pooling-server', version: '1.0.0'});

server.registerTool(
  'echo',
  {description: 'Returns a fixed string.'},
  async () => ({content: [{type: 'text', text: 'echo-ok'}]}),
);

const transport = new StdioServerTransport();
await server.connect(transport);
