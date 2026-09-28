/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing one tool over stdio. The tool name
 * carries this process id, so a caller can tell which server process answered
 * `tools/list`. The tool-list cache e2e test spawns it as a child process.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({name: 'e2e-tool-list-server', version: '1.0.0'});

server.registerTool(
  `ping_${process.pid}`,
  {description: 'Answers with the id of the server process.'},
  async () => ({content: [{type: 'text', text: String(process.pid)}]}),
);

const transport = new StdioServerTransport();
await server.connect(transport);
