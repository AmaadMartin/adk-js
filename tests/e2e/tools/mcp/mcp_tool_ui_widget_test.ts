/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  MCPToolset,
  PluginManager,
  createSession,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` lists and calls a real
 * MCP server spawned as a stdio child process (`mcp_app_tool_server.mjs`). Its
 * `echo` tool declares a `ui://` resource, so the widget the tool attaches
 * comes from a real listing rather than a fixture.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_app_tool_server.mjs', import.meta.url),
);

const FUNCTION_CALL_ID = 'e2e-call';

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'e2e-invocation',
      session: createSession({id: 'e2e-session', appName: 'e2e-app'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: FUNCTION_CALL_ID,
  });
}

function createToolset(): MCPToolset {
  return new MCPToolset({
    type: 'StdioConnectionParams',
    serverParams: {command: process.execPath, args: [SERVER_PATH]},
  });
}

describe('MCPTool MCP-App widget (e2e, real MCP server over stdio)', () => {
  it('attaches the widget the server declared to the event actions', async () => {
    const toolset = createToolset();
    const tools = await toolset.getTools();
    const echo = tools.find((tool) => tool.name === 'echo');
    if (!echo) {
      expect.fail('the server did not advertise the echo tool');
    }
    const toolContext = createToolContext();

    const result = await echo.runAsync({
      args: {message: 'hello'},
      toolContext,
    });

    expect(result).toMatchObject({content: [{type: 'text', text: 'hello'}]});
    expect(toolContext.eventActions.renderUiWidgets).toMatchObject([
      {
        id: FUNCTION_CALL_ID,
        provider: 'mcp',
        payload: {
          resource_uri: 'ui://widget/echo',
          tool_args: {message: 'hello'},
        },
      },
    ]);
    await toolset.close();
  });

  it('attaches no widget for a tool that declares no ui resource', async () => {
    const toolset = createToolset();
    const tools = await toolset.getTools();
    const plain = tools.find((tool) => tool.name === 'plain');
    if (!plain) {
      expect.fail('the server did not advertise the plain tool');
    }
    const toolContext = createToolContext();

    const result = await plain.runAsync({
      args: {message: 'hello'},
      toolContext,
    });

    expect(result).toMatchObject({content: [{type: 'text', text: 'hello'}]});
    expect(toolContext.eventActions.renderUiWidgets).toBeUndefined();
    await toolset.close();
  });
});
