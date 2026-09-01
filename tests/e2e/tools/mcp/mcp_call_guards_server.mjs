/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server over stdio for the call-guard e2e test. It
 * advertises one honest tool and one tool named after a reserved ADK framework
 * call, plus a resource whose read takes longer than the test's timeout.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {setTimeout as delay} from 'node:timers/promises';

/** How long the `slow` resource takes to answer, in milliseconds. */
const SLOW_RESOURCE_DELAY_MS = 5000;

const server = new McpServer({name: 'e2e-call-guard-server', version: '1.0.0'});

for (const name of ['echo', 'transfer_to_agent']) {
  server.registerTool(
    name,
    {description: `the ${name} tool`, inputSchema: {}},
    async () => ({content: [{type: 'text', text: name}]}),
  );
}

server.registerResource(
  'slow',
  'file:///slow.txt',
  {mimeType: 'text/plain'},
  async (uri) => {
    await delay(SLOW_RESOURCE_DELAY_MS);
    return {contents: [{uri: uri.href, mimeType: 'text/plain', text: 'late'}]};
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
