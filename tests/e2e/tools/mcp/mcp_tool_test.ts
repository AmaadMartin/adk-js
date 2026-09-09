/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  MCPSessionManager,
  MCPTool,
  PluginManager,
  createSession,
} from '@google/adk';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPTool` calls a real MCP server
 * (spawned as a stdio child process, see `mcp_app_tool_server.mjs`). It proves
 * that the `_meta` block survives a real listing, that a real call returns the
 * server's result, and that a real failure reaches the caller.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_app_tool_server.mjs', import.meta.url),
);

/** A tool name the server does not advertise, so calling it fails. */
const MISSING_TOOL_NAME = 'no-such-tool';

/** The message the client raises when the server dies mid-call. */
const CONNECTION_CLOSED = 'MCP error -32000: Connection closed';

function createSessionManager(): MCPSessionManager {
  return new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: process.execPath, args: [SERVER_PATH]},
  });
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'e2e-invocation',
      session: createSession({id: 'e2e-session', appName: 'e2e-app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

/** Reads the `echo` declaration off the running server. */
async function fetchEchoDeclaration(
  sessionManager: MCPSessionManager,
): Promise<Tool> {
  const session = await sessionManager.createSession();
  try {
    const {tools} = await session.listTools();
    const declaration = tools.find((tool) => tool.name === 'echo');
    if (!declaration) {
      expect.fail('the server did not advertise the echo tool');
    }
    return declaration;
  } finally {
    await sessionManager.closeSession(session);
  }
}

describe('MCPTool (e2e, real MCP server over stdio)', () => {
  let sessionManager: MCPSessionManager;

  afterEach(async () => {
    const sessions = sessionManager?.getActiveSessions() ?? [];
    await Promise.all(
      sessions.map((session) => sessionManager.closeSession(session)),
    );
  });

  it('reads the MCP-App metadata a real server advertises', async () => {
    sessionManager = createSessionManager();

    const tool = new MCPTool(
      await fetchEchoDeclaration(sessionManager),
      sessionManager,
    );

    expect(tool.mcpAppResourceUri).toBe('ui://widget/echo');
    expect(tool.rawMcpTool.name).toBe('echo');
  });

  it('calls the real tool and returns the server result', async () => {
    sessionManager = createSessionManager();
    const tool = new MCPTool(
      await fetchEchoDeclaration(sessionManager),
      sessionManager,
    );

    const result = await tool.runAsync({
      args: {message: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({
      content: [{type: 'text', text: 'hello'}],
    });
  });

  it('passes a server-reported failure through as an isError result', async () => {
    sessionManager = createSessionManager();
    const declaration = await fetchEchoDeclaration(sessionManager);
    const tool = new MCPTool(
      {...declaration, name: MISSING_TOOL_NAME},
      sessionManager,
    );

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({isError: true});
  });

  it('throws when the real server dies mid-call', async () => {
    sessionManager = createSessionManager();
    const declaration = await fetchEchoDeclaration(sessionManager);
    const tool = new MCPTool({...declaration, name: 'crash'}, sessionManager);

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow(CONNECTION_CLOSED);
  });
});
