/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  MCPToolset,
  PluginManager,
} from '@google/adk';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const SERVER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'echo_mcp_server.mjs',
);

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

/**
 * Drives a real MCP server over a real stdio transport, with no mocks, so the
 * deferred import is proven to resolve the actual package at run time.
 */
describe('MCPToolset against a real MCP server', () => {
  let toolset: MCPToolset | undefined;

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
  });

  it('discovers and calls a tool', async () => {
    toolset = new MCPToolset({
      type: 'StdioConnectionParams',
      serverParams: {command: process.execPath, args: [SERVER_PATH]},
    });

    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);

    const result = (await tools[0].runAsync({
      args: {message: 'hello'},
      toolContext: createToolContext(),
    })) as CallToolResult;

    expect(result.content).toEqual([{type: 'text', text: 'echo: hello'}]);
  });

  it('reports a connection failure from a server that cannot start', async () => {
    toolset = new MCPToolset({
      type: 'StdioConnectionParams',
      serverParams: {
        command: process.execPath,
        args: ['--no-such-flag'],
        // The child reports the bad flag on stderr; keep it out of the run.
        stderr: 'ignore',
      },
    });

    await expect(toolset.getTools()).rejects.toThrow(
      /Failed to create MCP session/,
    );
  });
});
