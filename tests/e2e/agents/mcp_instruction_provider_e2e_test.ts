/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InvocationContext,
  mcpInstructionProvider,
  ReadonlyContext,
  type StreamableHTTPConnectionParams,
} from '@google/adk';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import * as http from 'http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';

/** Builds a fresh MCP prompt server exposing the prompt under test. */
function createMcpServer(): McpServer {
  const server = new McpServer({name: 'test-prompt-server', version: '1.0.0'});

  // A prompt with a declared argument, returning multiple text messages.
  server.registerPrompt(
    'greeting_prompt',
    {argsSchema: {user_name: z.string()}},
    ({user_name}) => ({
      messages: [
        {role: 'user', content: {type: 'text', text: `Hello, ${user_name}! `}},
        {role: 'user', content: {type: 'text', text: 'Follow the guidelines.'}},
      ],
    }),
  );

  return server;
}

/**
 * Spins up a real in-process MCP prompt server over Streamable HTTP and drives
 * the full mcpInstructionProvider path against it with no mocks: real
 * MCPSessionManager, real MCP client/server round trip, real listPrompts and
 * getPrompt calls.
 */
describe('mcpInstructionProvider E2E (real MCP server)', () => {
  let httpServer: http.Server;
  let baseUrl: string;

  /** Builds a ReadonlyContext exposing only the given session state. */
  function makeContext(state: Record<string, unknown> = {}): ReadonlyContext {
    return new ReadonlyContext({
      session: {id: 'sess-1', appName: 'app', userId: 'user-1', state},
    } as unknown as InvocationContext);
  }

  function params(): StreamableHTTPConnectionParams {
    return {type: 'StreamableHTTPConnectionParams', url: `${baseUrl}/mcp`};
  }

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // Stateless Streamable HTTP: a fresh server + transport per request.
    app.all('/mcp', async (req, res) => {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    httpServer = http.createServer(app);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const address = httpServer.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('resolves an instruction, forwarding only declared args from state', async () => {
    const provider = mcpInstructionProvider(params(), 'greeting_prompt');

    const instruction = await provider(
      makeContext({user_name: 'Ada', unrelated: 'ignored'}),
    );

    expect(instruction).toBe('Hello, Ada! Follow the guidelines.');
  });
});
