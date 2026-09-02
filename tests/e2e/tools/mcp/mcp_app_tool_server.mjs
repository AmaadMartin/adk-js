/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing three tools over stdio.
 *
 * `weather` declares its user interface in `_meta.ui`, and its input schema uses
 * `oneOf`, which the genai `Schema` conversion cannot express. Asking for the
 * location `nowhere` returns a failed result (`isError`) instead of raising, so
 * a test can exercise the error path a server reports in band.
 *
 * `render_chart` is backed by an MCP App and `sum` is a plain tool with no user
 * interface, so a test can compare the widget path against a tool that declares
 * none.
 *
 * The e2e tests spawn this file as a child process.
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

const RENDER_CHART_TOOL = {
  name: 'render_chart',
  description: 'Renders a chart in an MCP App.',
  inputSchema: {
    type: 'object',
    properties: {
      series: {type: 'array', items: {type: 'number'}},
    },
    required: ['series'],
  },
  _meta: {ui: {resourceUri: 'ui://charts/bar'}},
};

const SUM_TOOL = {
  name: 'sum',
  description: 'Adds two numbers, with no UI.',
  inputSchema: {
    type: 'object',
    properties: {a: {type: 'number'}, b: {type: 'number'}},
    required: ['a', 'b'],
  },
};

const server = new Server(
  {name: 'e2e-mcp-app-server', version: '1.0.0'},
  {capabilities: {tools: {}}},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [WEATHER_TOOL, RENDER_CHART_TOOL, SUM_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};

  if (request.params.name === 'render_chart') {
    return {
      content: [{type: 'text', text: `charted ${args.series.length} points`}],
    };
  }

  if (request.params.name === 'sum') {
    return {content: [{type: 'text', text: String(args.a + args.b)}]};
  }

  if (args.location === 'nowhere') {
    return {
      content: [{type: 'text', text: 'unknown location'}],
      isError: true,
    };
  }
  return {content: [{type: 'text', text: 'sunny'}], isError: false};
});

const transport = new StdioServerTransport();
await server.connect(transport);
