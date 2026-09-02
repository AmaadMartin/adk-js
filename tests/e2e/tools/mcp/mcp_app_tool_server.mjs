/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing one MCP App tool over stdio.
 *
 * The tool declares its user interface in `_meta.ui`, and its input schema uses
 * `oneOf`, which the genai `Schema` conversion cannot express. Asking for the
 * location `nowhere` returns a failed result (`isError`) instead of raising, so
 * a test can exercise the error path a server reports in band.
 *
 * The e2e test spawns this file as a child process.
 */

import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const WEATHER_TOOL = {
  name: 'weather',
  description: 'Reports the weather for a location.',
  inputSchema: {
    type: 'object',
    properties: {
      location: {oneOf: [{type: 'string'}, {type: 'number'}]},
    },
    required: ['location'],
  },
  _meta: {
    ui: {
      visibility: ['app', 'debug'],
      resourceUri: 'ui://weather-card',
    },
  },
};

const server = new Server(
  {name: 'e2e-mcp-app-server', version: '1.0.0'},
  {capabilities: {tools: {}}},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [WEATHER_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.arguments?.location === 'nowhere') {
    return {
      content: [{type: 'text', text: 'unknown location'}],
      isError: true,
    };
  }
  return {content: [{type: 'text', text: 'sunny'}], isError: false};
});

const transport = new StdioServerTransport();
await server.connect(transport);
