/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server that writes a diagnostic line to its stderr and
 * exposes one resource and one tool over stdio. The `errlog` e2e test spawns
 * it as a child process to prove that a real server's stderr reaches the
 * configured stream, both while listing and while running a tool.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

export const STDERR_BANNER = 'e2e-errlog-server: ready';
export const STDERR_TOOL_LINE = 'e2e-errlog-server: ping called';

const server = new McpServer({name: 'e2e-errlog-server', version: '1.0.0'});

server.registerResource(
  'greeting',
  'file:///greeting.txt',
  {mimeType: 'text/plain'},
  async (uri) => ({
    contents: [{uri: uri.href, mimeType: 'text/plain', text: 'hello'}],
  }),
);

server.registerTool('ping', {description: 'Writes to stderr'}, async () => {
  process.stderr.write(`${STDERR_TOOL_LINE}\n`);
  return {content: [{type: 'text', text: 'pong'}]};
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(`${STDERR_BANNER}\n`);
