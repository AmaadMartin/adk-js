/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  FeatureName,
  InvocationContext,
  Logger,
  MCPSessionManager,
  MCPTool,
  PluginManager,
  createSession,
  getLogger,
  setLogger,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpError, Tool} from '@modelcontextprotocol/sdk/types.js';
import {MockInstance, afterEach, describe, expect, it, vi} from 'vitest';

const MCP_TOOL: Tool = {
  name: 'test-tool',
  description: 'A test tool',
  inputSchema: {type: 'object', properties: {}},
};

/** An MCP error code the SDK reserves for a server-reported failure. */
const SERVER_ERROR_CODE = -32000;

interface Harness {
  tool: MCPTool;
  toolContext: Context;
  callTool: MockInstance<Client['callTool']>;
  closeSession: MockInstance<MCPSessionManager['closeSession']>;
}

/**
 * Builds an `MCPTool` over a real session manager and a real MCP client whose
 * transport calls are stubbed, so no type is widened to reach them.
 */
function buildHarness(): Harness {
  const client = new Client({name: 'test-client', version: '1.0.0'});
  const sessionManager = new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: 'unused'},
  });
  vi.spyOn(sessionManager, 'createSession').mockResolvedValue(client);
  const closeSession = vi
    .spyOn(sessionManager, 'closeSession')
    .mockResolvedValue(undefined);

  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager(),
    abortSignal: new AbortController().signal,
  });

  return {
    tool: new MCPTool(MCP_TOOL, sessionManager),
    toolContext: new Context({invocationContext}),
    callTool: vi.spyOn(client, 'callTool'),
    closeSession,
  };
}

/**
 * Routes ADK warnings into the returned array for the rest of the test. The
 * `afterEach` below puts the previous logger back.
 */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  const noop = () => {};
  const capturingLogger: Logger = {
    setLogLevel: noop,
    log: noop,
    debug: noop,
    info: noop,
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: noop,
  };
  setLogger(capturingLogger);
  return warnings;
}

describe('MCPTool graceful error boundary', () => {
  const originalLogger = getLogger();

  afterEach(() => {
    setLogger(originalLogger);
    vi.restoreAllMocks();
  });

  it('returns an error result for an MCP protocol error when the feature is on', async () => {
    const {tool, toolContext, callTool} = buildHarness();
    callTool.mockRejectedValue(
      new McpError(SERVER_ERROR_CODE, "Client error '403 Forbidden'"),
    );

    const result = await withTemporaryFeatureOverride(
      FeatureName.MCP_GRACEFUL_ERROR_HANDLING,
      true,
      () => tool.runAsync({args: {}, toolContext}),
    );

    expect(result).toEqual({
      error:
        "MCP tool execution failed: MCP error -32000: Client error '403 Forbidden'",
    });
  });

  it('returns an error result for any other error when the feature is on', async () => {
    const {tool, toolContext, callTool} = buildHarness();
    callTool.mockRejectedValue(new Error('Failed to create MCP session'));

    const result = await withTemporaryFeatureOverride(
      FeatureName.MCP_GRACEFUL_ERROR_HANDLING,
      true,
      () => tool.runAsync({args: {}, toolContext}),
    );

    expect(result).toEqual({
      error:
        'Unexpected error during MCP tool execution: Failed to create MCP session',
    });
  });

  it('reports the root cause of a wrapped error', async () => {
    const {tool, toolContext, callTool} = buildHarness();
    callTool.mockRejectedValue(
      new Error('Failed to create MCP session', {
        cause: new Error('ECONNREFUSED 127.0.0.1:8788'),
      }),
    );

    const result = await withTemporaryFeatureOverride(
      FeatureName.MCP_GRACEFUL_ERROR_HANDLING,
      true,
      () => tool.runAsync({args: {}, toolContext}),
    );

    expect(result).toEqual({
      error:
        'Unexpected error during MCP tool execution: Failed to create MCP ' +
        'session: ECONNREFUSED 127.0.0.1:8788',
    });
  });

  it('logs the failure it reports', async () => {
    const {tool, toolContext, callTool} = buildHarness();
    const warnings = captureWarnings();
    callTool.mockRejectedValue(new Error('Call failed'));

    await withTemporaryFeatureOverride(
      FeatureName.MCP_GRACEFUL_ERROR_HANDLING,
      true,
      () => tool.runAsync({args: {}, toolContext}),
    );

    expect(warnings).toContain(
      'Unexpected error during MCP tool execution: Call failed',
    );
  });

  it('closes the session when the feature turns a failure into a result', async () => {
    const {tool, toolContext, callTool, closeSession} = buildHarness();
    callTool.mockRejectedValue(new Error('Call failed'));

    await withTemporaryFeatureOverride(
      FeatureName.MCP_GRACEFUL_ERROR_HANDLING,
      true,
      () => tool.runAsync({args: {}, toolContext}),
    );

    expect(closeSession).toHaveBeenCalledOnce();
  });

  it('throws when the feature is off', async () => {
    const {tool, toolContext, callTool} = buildHarness();
    callTool.mockRejectedValue(
      new McpError(SERVER_ERROR_CODE, "Client error '403 Forbidden'"),
    );

    await expect(
      withTemporaryFeatureOverride(
        FeatureName.MCP_GRACEFUL_ERROR_HANDLING,
        false,
        () => tool.runAsync({args: {}, toolContext}),
      ),
    ).rejects.toThrow(McpError);
  });

  it('throws when no feature override is set', async () => {
    const {tool, toolContext, callTool} = buildHarness();
    callTool.mockRejectedValue(new Error('Call failed'));

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );
  });

  it('passes a successful result through untouched when the feature is on', async () => {
    const {tool, toolContext, callTool} = buildHarness();
    const serverResult = {
      content: [{type: 'text' as const, text: 'done'}],
      isError: true,
      vendorField: 'kept',
    };
    callTool.mockResolvedValue(serverResult);

    const result = await withTemporaryFeatureOverride(
      FeatureName.MCP_GRACEFUL_ERROR_HANDLING,
      true,
      () => tool.runAsync({args: {}, toolContext}),
    );

    expect(result).toEqual(serverResult);
  });
});
