/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LlmAgent,
  MCPSessionManager,
  MCPTool,
  PluginManager,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {CallToolResult, Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, vi} from 'vitest';

const REQUIRES_CONFIRMATION = {
  error: 'This tool call requires confirmation, please approve or reject.',
};
const REJECTED = {error: 'This tool call is rejected.'};
const SERVER_RESULT: CallToolResult = {
  content: [{type: 'text', text: 'deleted'}],
};

const DESTRUCTIVE_ARGS = {path: '/etc'};
const BENIGN_ARGS = {path: '/tmp/scratch'};

const mcpTool: Tool = {
  name: 'delete_file',
  description: 'Deletes a file.',
  inputSchema: {type: 'object', properties: {path: {type: 'string'}}},
};

function makeContext(options: {
  functionCallId?: string;
  toolConfirmation?: ToolConfirmation;
}): Context {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u1',
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, ...options});
}

/**
 * A real session manager whose transport-touching methods are stubbed, so a
 * test can assert the server is not contacted, and the stubs stay checked
 * against the real signatures.
 */
function makeSessionManager() {
  const client = new Client({name: 'test-client', version: '1.0.0'});
  const callTool = vi
    .spyOn(client, 'callTool')
    .mockResolvedValue(SERVER_RESULT);
  const sessionManager = new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: 'never-spawned'},
  });
  const createMcpSession = vi
    .spyOn(sessionManager, 'createSession')
    .mockResolvedValue(client);
  vi.spyOn(sessionManager, 'closeSession').mockResolvedValue(undefined);
  return {sessionManager, createMcpSession, callTool};
}

describe('MCPTool requireConfirmation', () => {
  it('requests confirmation and never opens a session', async () => {
    const {sessionManager, createMcpSession} = makeSessionManager();
    const tool = new MCPTool(mcpTool, sessionManager, undefined, true);
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({
      args: DESTRUCTIVE_ARGS,
      toolContext: ctx,
    });

    expect(result).toEqual(REQUIRES_CONFIRMATION);
    expect(createMcpSession).not.toHaveBeenCalled();
    expect(ctx.actions.requestedToolConfirmations['fc-1']).toBeDefined();
    expect(ctx.actions.skipSummarization).toBe(true);
  });

  it('calls the server once the user confirmed', async () => {
    const {sessionManager, callTool} = makeSessionManager();
    const tool = new MCPTool(
      {...mcpTool, name: 'srv_delete_file'},
      sessionManager,
      'delete_file',
      true,
    );
    const ctx = makeContext({
      functionCallId: 'fc-1',
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });

    const result = await tool.runAsync({
      args: DESTRUCTIVE_ARGS,
      toolContext: ctx,
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      {name: 'delete_file', arguments: DESTRUCTIVE_ARGS},
      undefined,
      {signal: ctx.abortSignal},
    );
    expect(result).toEqual(SERVER_RESULT);
  });

  it('rejects the call and never opens a session once the user declined', async () => {
    const {sessionManager, createMcpSession} = makeSessionManager();
    const tool = new MCPTool(mcpTool, sessionManager, undefined, true);
    const ctx = makeContext({
      functionCallId: 'fc-1',
      toolConfirmation: new ToolConfirmation({confirmed: false}),
    });

    const result = await tool.runAsync({
      args: DESTRUCTIVE_ARGS,
      toolContext: ctx,
    });

    expect(result).toEqual(REJECTED);
    expect(createMcpSession).not.toHaveBeenCalled();
  });

  it('runs the tool when the predicate returns false', async () => {
    const {sessionManager, callTool} = makeSessionManager();
    const tool = new MCPTool(
      mcpTool,
      sessionManager,
      undefined,
      (args) => args['path'] === '/etc',
    );
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({args: BENIGN_ARGS, toolContext: ctx});

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result).toEqual(SERVER_RESULT);
  });

  it('gates the tool when the predicate returns true', async () => {
    const {sessionManager, createMcpSession} = makeSessionManager();
    const predicate = vi.fn().mockReturnValue(true);
    const tool = new MCPTool(mcpTool, sessionManager, undefined, predicate);
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({
      args: DESTRUCTIVE_ARGS,
      toolContext: ctx,
    });

    expect(result).toEqual(REQUIRES_CONFIRMATION);
    expect(createMcpSession).not.toHaveBeenCalled();
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate).toHaveBeenCalledWith(DESTRUCTIVE_ARGS, ctx);
    expect(predicate.mock.calls[0][1]).toBe(ctx);
  });

  it('awaits an async predicate', async () => {
    const {sessionManager, createMcpSession} = makeSessionManager();
    const tool = new MCPTool(mcpTool, sessionManager, undefined, async () =>
      Promise.resolve(true),
    );
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({
      args: DESTRUCTIVE_ARGS,
      toolContext: ctx,
    });

    expect(result).toEqual(REQUIRES_CONFIRMATION);
    expect(createMcpSession).not.toHaveBeenCalled();
  });

  it('runs unguarded when no confirmation option is passed', async () => {
    const {sessionManager, callTool} = makeSessionManager();
    const tool = new MCPTool(mcpTool, sessionManager);
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({
      args: DESTRUCTIVE_ARGS,
      toolContext: ctx,
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result).toEqual(SERVER_RESULT);
  });
});
