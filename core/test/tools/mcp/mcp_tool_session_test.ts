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
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {MockInstance, afterEach, describe, expect, it, vi} from 'vitest';

const FUNCTION_CALL_ID = 'call-1';

const MCP_TOOL: Tool = {
  name: 'chart-tool',
  description: 'Draws a chart',
  inputSchema: {type: 'object', properties: {}},
};

interface Harness {
  tool: MCPTool;
  toolContext: Context;
  callTool: MockInstance<Client['callTool']>;
  createSession: MockInstance<MCPSessionManager['createSession']>;
  closeSession: MockInstance<MCPSessionManager['closeSession']>;
  runGuarded: MockInstance<MCPSessionManager['runGuarded']>;
  session: Client;
}

/**
 * Builds an `MCPTool` over a real session manager and a real MCP client whose
 * transport calls are stubbed, so no type is widened to reach them.
 */
function buildHarness(abortSignal?: AbortSignal): Harness {
  const session = new Client({name: 'test-client', version: '1.0.0'});
  const sessionManager = new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: 'unused'},
  });

  return {
    tool: new MCPTool(MCP_TOOL, sessionManager),
    toolContext: new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        session: createSession({id: 'test-session', appName: 'test-app'}),
        pluginManager: new PluginManager(),
        abortSignal,
      }),
      functionCallId: FUNCTION_CALL_ID,
    }),
    callTool: vi.spyOn(session, 'callTool').mockResolvedValue({content: []}),
    createSession: vi
      .spyOn(sessionManager, 'createSession')
      .mockResolvedValue(session),
    closeSession: vi
      .spyOn(sessionManager, 'closeSession')
      .mockResolvedValue(undefined),
    runGuarded: vi.spyOn(sessionManager, 'runGuarded'),
    session,
  };
}

describe('MCPTool transport guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the call through the session manager guard', async () => {
    const harness = buildHarness();

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(harness.runGuarded).toHaveBeenCalledWith(
      harness.session,
      expect.any(Promise),
    );
  });

  it('surfaces a lost connection and still closes the session', async () => {
    const harness = buildHarness();
    harness.runGuarded.mockRejectedValue(
      new Error('MCP session connection lost: Forbidden'),
    );

    await expect(
      harness.tool.runAsync({args: {}, toolContext: harness.toolContext}),
    ).rejects.toThrow('MCP session connection lost: Forbidden');
    expect(harness.closeSession).toHaveBeenCalledWith(harness.session);
  });
});

describe('MCPTool session setup retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the session again when setup fails once', async () => {
    const harness = buildHarness();
    harness.createSession
      .mockRejectedValueOnce(
        new Error('Failed to create MCP session: ECONNRESET'),
      )
      .mockResolvedValue(harness.session);

    const result = await harness.tool.runAsync({
      args: {},
      toolContext: harness.toolContext,
    });

    expect(result).toEqual({content: []});
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(harness.callTool).toHaveBeenCalledTimes(1);
  });

  it('gives up when setup fails twice', async () => {
    const harness = buildHarness();
    harness.createSession.mockRejectedValue(new Error('server is down'));

    await expect(
      harness.tool.runAsync({args: {}, toolContext: harness.toolContext}),
    ).rejects.toThrow('server is down');
    expect(harness.createSession).toHaveBeenCalledTimes(2);
    expect(harness.callTool).not.toHaveBeenCalled();
  });

  it('does not retry setup once the invocation is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = buildHarness(controller.signal);
    harness.createSession.mockRejectedValue(new Error('aborted'));

    await expect(
      harness.tool.runAsync({args: {}, toolContext: harness.toolContext}),
    ).rejects.toThrow('aborted');
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('never re-sends a call that failed after it was dispatched', async () => {
    const harness = buildHarness();
    harness.createSession.mockResolvedValue(harness.session);
    harness.callTool.mockRejectedValue(new Error('tool exploded'));

    await expect(
      harness.tool.runAsync({args: {}, toolContext: harness.toolContext}),
    ).rejects.toThrow('tool exploded');
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(harness.callTool).toHaveBeenCalledTimes(1);
  });
});
