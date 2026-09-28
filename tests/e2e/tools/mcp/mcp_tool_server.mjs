/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing one tool over stdio. The tool echoes the
 * `traceparent` the client put in the request `_meta`, so the trace-context
 * e2e test can read what actually arrived on the wire.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

/** Reported when the request carries no trace context. */
const NO_TRACE_CONTEXT = 'no-trace-context';

const server = new McpServer({
  name: 'e2e-trace-context-server',
  version: '1.0.0',
});

server.registerTool(
  'echo-trace-context',
  {description: 'Echoes the traceparent received in the request _meta'},
  async (extra) => ({
    content: [
      {type: 'text', text: extra._meta?.traceparent ?? NO_TRACE_CONTEXT},
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
