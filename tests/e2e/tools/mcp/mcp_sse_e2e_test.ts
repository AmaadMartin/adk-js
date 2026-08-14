/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end test with NO mocks: a real `MCPToolset` configured with
 * `SseConnectionParams` talks to a real MCP server over HTTP+SSE on loopback
 * (see `mcp_sse_server.ts`). It proves the new transport discovers and runs
 * tools, forwards the configured headers, and reports a refused stream.
 */

import {
  Context,
  InMemorySessionService,
  InvocationContext,
  MCPToolset,
  PluginManager,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

import {SseTestServer, startSseServer} from './mcp_sse_server.js';

const APP_NAME = 'mcp-sse-e2e';

async function createToolContext(): Promise<Context> {
  const session = await new InMemorySessionService().createSession({
    appName: APP_NAME,
    userId: 'e2e-user',
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'e2e-invocation',
      session,
      pluginManager: new PluginManager(),
    }),
  });
}

describe('MCPToolset with SseConnectionParams (e2e, real MCP server over HTTP+SSE)', () => {
  let server: SseTestServer | undefined;
  let toolset: MCPToolset | undefined;

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
    await server?.close();
    server = undefined;
  });

  it('discovers and runs a tool over a real SSE connection', async () => {
    server = await startSseServer();
    toolset = new MCPToolset({type: 'SseConnectionParams', url: server.url});

    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);

    const result = await tools[0].runAsync({
      args: {text: 'hello sse'},
      toolContext: await createToolContext(),
    });

    expect(result).toMatchObject({
      content: [{type: 'text', text: 'echo: hello sse'}],
    });
  });

  it('sends the configured headers on the real client messages', async () => {
    server = await startSseServer();
    toolset = new MCPToolset({
      type: 'SseConnectionParams',
      url: server.url,
      transportOptions: {
        requestInit: {headers: {'x-e2e-token': 'e2e-token-value'}},
      },
    });

    await toolset.getTools();

    expect(server.postHeaders.length).toBeGreaterThan(0);
    for (const headers of server.postHeaders) {
      expect(headers['x-e2e-token']).toBe('e2e-token-value');
    }
  });

  it('reports a refused SSE stream as a session failure', async () => {
    server = await startSseServer({rejectStreamWithStatus: 403});
    toolset = new MCPToolset({type: 'SseConnectionParams', url: server.url});

    await expect(toolset.getTools()).rejects.toThrow(
      'Failed to create MCP session',
    );
  });
});
