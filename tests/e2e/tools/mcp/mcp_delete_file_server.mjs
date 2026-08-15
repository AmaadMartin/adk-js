/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing one destructive tool (`delete_file`) over
 * stdio. It is spawned as a child process by the MCP confirmation e2e test:
 * because the tool really deletes the file, the presence of the file after a
 * call proves the request never reached this server.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {unlink} from 'node:fs/promises';
import {z} from 'zod';

const server = new McpServer({
  name: 'e2e-delete-file-server',
  version: '1.0.0',
});

server.registerTool(
  'delete_file',
  {
    description: 'Deletes the file at the given path.',
    inputSchema: {path: z.string()},
  },
  async ({path}) => {
    await unlink(path);
    return {content: [{type: 'text', text: `deleted ${path}`}]};
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
