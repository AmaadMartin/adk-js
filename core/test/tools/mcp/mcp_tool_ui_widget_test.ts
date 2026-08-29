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

/** Builds a tool declaration carrying the given MCP `_meta` block. */
function toolWithMeta(meta?: Record<string, unknown>): Tool {
  return {
    name: 'chart-tool',
    description: 'Draws a chart',
    inputSchema: {type: 'object', properties: {}},
    _meta: meta,
  };
}

interface Harness {
  tool: MCPTool;
  toolContext: Context;
  callTool: MockInstance<Client['callTool']>;
}

/**
 * Builds an `MCPTool` over a real session manager and a real MCP client whose
 * transport calls are stubbed, so no type is widened to reach them.
 */
function buildHarness(
  mcpTool: Tool,
  contextOptions: {functionCallId?: string} = {
    functionCallId: FUNCTION_CALL_ID,
  },
) {
  const session = new Client({name: 'test-client', version: '1.0.0'});
  const callTool = vi
    .spyOn(session, 'callTool')
    .mockResolvedValue({content: []});

  const sessionManager = new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: 'unused'},
  });
  vi.spyOn(sessionManager, 'createSession').mockResolvedValue(session);
  vi.spyOn(sessionManager, 'closeSession').mockResolvedValue(undefined);

  const harness: Harness = {
    tool: new MCPTool(mcpTool, sessionManager),
    toolContext: new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        session: createSession({id: 'test-session', appName: 'test-app'}),
        pluginManager: new PluginManager(),
      }),
      functionCallId: contextOptions.functionCallId,
    }),
    callTool,
  };
  return harness;
}

/** Runs the tool and returns the widgets it attached. */
async function runAndReadWidgets(harness: Harness, args = {city: 'Paris'}) {
  await harness.tool.runAsync({args, toolContext: harness.toolContext});
  return harness.toolContext.eventActions.renderUiWidgets;
}

describe('MCPTool MCP-App widget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches a widget for a tool declaring a nested resource URI', async () => {
    const mcpTool = toolWithMeta({ui: {resourceUri: 'ui://chart'}});
    const harness = buildHarness(mcpTool);

    const widgets = await runAndReadWidgets(harness);

    expect(widgets).toEqual([
      {
        id: FUNCTION_CALL_ID,
        provider: 'mcp',
        payload: {
          resource_uri: 'ui://chart',
          tool: mcpTool,
          tool_args: {city: 'Paris'},
        },
      },
    ]);
  });

  it('attaches a widget for the deprecated flat resource URI', async () => {
    const harness = buildHarness(toolWithMeta({'ui/resourceUri': 'ui://flat'}));

    const widgets = await runAndReadWidgets(harness);

    expect(widgets?.[0]?.payload['resource_uri']).toBe('ui://flat');
  });

  it('attaches no widget when the tool declares no _meta', async () => {
    const harness = buildHarness(toolWithMeta());

    expect(await runAndReadWidgets(harness)).toBeUndefined();
  });

  it('attaches no widget for a URI outside the ui:// scheme', async () => {
    const harness = buildHarness(
      toolWithMeta({ui: {resourceUri: 'https://example.com/app'}}),
    );

    expect(await runAndReadWidgets(harness)).toBeUndefined();
  });

  it('attaches no widget when the call carries no function call id', async () => {
    // A widget is addressed by its function call id. Attaching one under an
    // empty id would collide with the next, and the collision would throw
    // after the tool had already answered.
    const harness = buildHarness(
      toolWithMeta({ui: {resourceUri: 'ui://chart'}}),
      {},
    );

    const result = await harness.tool.runAsync({
      args: {},
      toolContext: harness.toolContext,
    });

    expect(result).toEqual({content: []});
    expect(harness.toolContext.eventActions.renderUiWidgets).toBeUndefined();
  });

  it('attaches no widget when the call fails', async () => {
    const harness = buildHarness(toolWithMeta({ui: {resourceUri: 'ui://x'}}));
    harness.callTool.mockRejectedValue(new Error('tool exploded'));

    await expect(
      harness.tool.runAsync({args: {}, toolContext: harness.toolContext}),
    ).rejects.toThrow('tool exploded');
    expect(harness.toolContext.eventActions.renderUiWidgets).toBeUndefined();
  });
});
