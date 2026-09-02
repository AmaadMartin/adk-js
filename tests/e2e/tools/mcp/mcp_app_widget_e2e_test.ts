/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  InvocationContext,
  MCPTool,
  MCPToolset,
  PluginManager,
  createSession,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * (spawned as a stdio child process, see `mcp_app_tool_server.mjs`) that
 * advertises one MCP App tool and one plain tool. This proves the server's
 * `_meta` really reaches `MCPTool`, and that a real call renders the widget.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_app_tool_server.mjs', import.meta.url),
);

function createToolset(): MCPToolset {
  return new MCPToolset({
    type: 'StdioConnectionParams',
    serverParams: {command: process.execPath, args: [SERVER_PATH]},
  });
}

function makeContext(functionCallId: string): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'e2e-inv',
      session: createSession({
        id: 'e2e-session',
        appName: 'e2e-app',
        userId: 'e2e-user',
      }),
      pluginManager: new PluginManager(),
    }),
    functionCallId,
  });
}

/**
 * Narrows a listed tool to an {@link MCPTool} by the accessor it adds.
 *
 * Structural rather than `instanceof`: an object built by one copy of the
 * package fails `instanceof` against the class from a second copy, which is
 * why the repository guidelines rule `instanceof` out for type detection.
 */
function isMcpTool(tool: BaseTool): tool is MCPTool {
  return 'rawMcpTool' in tool;
}

function findTool(tools: BaseTool[], name: string): MCPTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool || !isMcpTool(tool)) {
    expect.fail(`the server did not advertise an MCPTool named '${name}'`);
  }
  return tool;
}

describe('MCPTool MCP App widget (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  it('reads the resource URI the real server declares', async () => {
    toolset = createToolset();

    const tools = await toolset.getTools();

    expect(findTool(tools, 'render_chart').mcpAppResourceUri).toBe(
      'ui://charts/bar',
    );
    expect(findTool(tools, 'sum').mcpAppResourceUri).toBeUndefined();
    expect(findTool(tools, 'sum').rawMcpTool.name).toBe('sum');
  });

  it('renders the widget after a real call, with snake_case payload keys', async () => {
    toolset = createToolset();
    const tool = findTool(await toolset.getTools(), 'render_chart');
    const toolContext = makeContext('e2e-call-id');
    const args = {series: [1, 2, 3]};

    const result = await tool.runAsync({args, toolContext});

    expect(result).toMatchObject({
      content: [{type: 'text', text: 'charted 3 points'}],
    });
    expect(toolContext.actions.renderUiWidgets).toEqual([
      {
        id: 'e2e-call-id',
        provider: 'mcp',
        payload: {
          resource_uri: 'ui://charts/bar',
          tool: tool.rawMcpTool,
          tool_args: args,
        },
      },
    ]);
  });

  it('renders no widget for a real tool with no MCP App', async () => {
    toolset = createToolset();
    const tool = findTool(await toolset.getTools(), 'sum');
    const toolContext = makeContext('e2e-call-id');

    const result = await tool.runAsync({args: {a: 2, b: 3}, toolContext});

    expect(result).toMatchObject({content: [{type: 'text', text: '5'}]});
    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });
});
