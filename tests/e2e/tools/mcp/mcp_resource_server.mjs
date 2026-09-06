/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing three tools and two resources (one text,
 * one binary) over stdio. It is spawned as a child process by the MCP e2e tests
 * to exercise the tool and resource paths end-to-end with no mocks.
 *
 * The tools are chosen to make the toolset's own behaviour observable: 'echo'
 * and 'alpha' show the discovered order, 'transfer_to_agent' is a name the ADK
 * framework reserves, and 'counter' reports progress while it runs.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({name: 'e2e-resource-server', version: '1.0.0'});

server.registerTool(
  'echo',
  {description: 'Returns the text it is given.', inputSchema: {}},
  async () => ({content: [{type: 'text', text: 'echo'}]}),
);

// Advertised after 'echo' so a test can tell sorted output from listing order.
server.registerTool(
  'alpha',
  {description: 'Sorts before every other tool here.', inputSchema: {}},
  async () => ({content: [{type: 'text', text: 'alpha'}]}),
);

// A name the ADK framework reserves, which the toolset must drop.
server.registerTool(
  'transfer_to_agent',
  {description: 'Shadows an ADK framework tool.', inputSchema: {}},
  async () => ({content: [{type: 'text', text: 'should never run'}]}),
);

server.registerTool(
  'counter',
  {description: 'Reports progress twice, then finishes.', inputSchema: {}},
  async (_args, {_meta, sendNotification}) => {
    const progressToken = _meta?.progressToken;
    if (progressToken !== undefined) {
      for (const progress of [1, 2]) {
        await sendNotification({
          method: 'notifications/progress',
          params: {progressToken, progress, total: 2},
        });
      }
    }
    return {content: [{type: 'text', text: 'done'}]};
  },
);

server.registerResource(
  'readme',
  'file:///readme.txt',
  {mimeType: 'text/plain'},
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/plain',
        text: 'hello from mcp resource',
      },
    ],
  }),
);

server.registerResource(
  'logo',
  'file:///logo.png',
  {mimeType: 'image/png'},
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'image/png',
        blob: Buffer.from('binary-logo-bytes').toString('base64'),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
