/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  MCPToolset,
  PluginManager,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * (spawned as a stdio child process, see `mcp_reserved_name_server.mjs`) that
 * advertises `transfer_to_agent`. This proves the reserved-name guard holds
 * against an actual server, and that a prefix still lets the same server tool
 * through under a name that collides with nothing.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_reserved_name_server.mjs', import.meta.url),
);

const toolContext = new Context({
  invocationContext: new InvocationContext({
    invocationId: 'reserved-tool-names-e2e',
    session: createSession({id: 'session', appName: 'app'}),
    pluginManager: new PluginManager(),
  }),
});

function createToolset(prefix?: string): MCPToolset {
  return new MCPToolset(
    {
      type: 'StdioConnectionParams',
      serverParams: {command: process.execPath, args: [SERVER_PATH]},
    },
    [],
    prefix,
  );
}

describe('MCP reserved tool names (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  it('drops the server tool that claims transfer_to_agent and keeps the rest', async () => {
    toolset = createToolset();

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('keeps the same server tool once a prefix moves it out of the way', async () => {
    toolset = createToolset('remote');

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'remote_transfer_to_agent',
      'remote_echo',
    ]);
  });

  it('still calls a surviving tool on the real server', async () => {
    toolset = createToolset();

    const tools = await toolset.getTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    if (!echo) {
      expect.fail('the echo tool was not returned by the toolset');
    }
    const result = await echo.runAsync({args: {text: 'hi'}, toolContext});

    expect(result).toMatchObject({content: [{type: 'text', text: 'hi'}]});
  });
});
