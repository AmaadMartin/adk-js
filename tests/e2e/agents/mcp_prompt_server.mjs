/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A minimal, real MCP server exposing one prompt over stdio. It is spawned as a
 * child process by the mcpInstructionProvider e2e test, so the provider runs
 * against an actual MCP server with no mocks.
 *
 * The prompt declares a single argument, `user_name`, and echoes back every
 * argument it received. That lets the test prove undeclared session-state keys
 * never reach the server.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const server = new McpServer({name: 'e2e-prompt-server', version: '1.0.0'});

server.registerPrompt(
  'support_system_prompt',
  {
    description: 'The support agent system prompt.',
    argsSchema: {user_name: z.string()},
  },
  (args) => ({
    messages: [
      {
        role: 'assistant',
        content: {type: 'text', text: `You help ${args.user_name}. `},
      },
      {
        role: 'assistant',
        content: {type: 'text', text: `Received: ${JSON.stringify(args)}`},
      },
    ],
  }),
);

server.registerPrompt(
  'empty_prompt',
  {description: 'Returns no messages.'},
  () => ({
    messages: [],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
