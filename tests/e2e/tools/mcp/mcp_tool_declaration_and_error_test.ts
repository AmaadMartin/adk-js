/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  FeatureName,
  InvocationContext,
  LlmAgent,
  MCPTool,
  MCPToolset,
  PluginManager,
  createSession,
  overrideFeatureEnabled,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * (spawned as a stdio child process, see `mcp_app_tool_server.mjs`) that
 * advertises an MCP App tool. It proves the three accessors read what an actual
 * server sent, rather than what a test double was told to return.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_app_tool_server.mjs', import.meta.url),
);

/** A real tool context; the call path reads only its abort signal. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'mcp-e2e-1',
      agent: new LlmAgent({name: 'weather_agent', model: 'gemini-2.5-flash'}),
      session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

function createToolset(): MCPToolset {
  return new MCPToolset({
    type: 'StdioConnectionParams',
    serverParams: {command: process.execPath, args: [SERVER_PATH]},
  });
}

/** Narrows a toolset's tool structurally, as `isBaseLlm` does for models. */
function isMcpTool(tool: BaseTool): tool is MCPTool {
  return 'visibility' in tool;
}

async function weatherTool(toolset: MCPToolset): Promise<MCPTool> {
  const tool = (await toolset.getTools()).find(
    (candidate) => candidate.name === 'weather',
  );
  if (!tool || !isMcpTool(tool)) {
    expect.fail('the server did not advertise the weather tool');
  }
  return tool;
}

describe('MCPTool (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, undefined);
    await toolset?.close();
  });

  it('reads the visibility the server declared in _meta', async () => {
    toolset = createToolset();

    expect((await weatherTool(toolset)).visibility).toEqual(['app', 'debug']);
  });

  it("declares the server's own schema when JSON_SCHEMA_FOR_FUNC_DECL is on", async () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    toolset = createToolset();

    const declaration = (await weatherTool(toolset))._getDeclaration();

    expect(declaration.parametersJsonSchema).toMatchObject({
      properties: {location: {oneOf: [{type: 'string'}, {type: 'number'}]}},
    });
    expect(declaration.parameters).toBeUndefined();
  });

  it('drops the oneOf when the feature is off', async () => {
    toolset = createToolset();

    const declaration = (await weatherTool(toolset))._getDeclaration();

    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters?.properties?.['location']).not.toHaveProperty(
      'oneOf',
    );
  });

  it('detects the failure a real server reports with isError', async () => {
    toolset = createToolset();
    const tool = await weatherTool(toolset);

    const failed = await tool.runAsync({
      args: {location: 'nowhere'},
      toolContext: createToolContext(),
    });
    const succeeded = await tool.runAsync({
      args: {location: 'paris'},
      toolContext: createToolContext(),
    });

    expect(tool.detectErrorInResponse(failed)).toBe('MCP_TOOL_ERROR');
    expect(tool.detectErrorInResponse(succeeded)).toBeUndefined();
  });
});
