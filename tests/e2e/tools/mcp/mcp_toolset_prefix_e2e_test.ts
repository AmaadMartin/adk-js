/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, LlmRequest, MCPToolset} from '@google/adk';
import {Tool, ToolUnion} from '@google/genai';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: two real MCP servers (spawned as stdio child
 * processes, see `mcp_search_server.mjs`) both expose a tool called `search`.
 * Prefixing them apart happens in `BaseToolset.getToolsWithPrefix()`, and this
 * proves the prefixed name reaches the request while the call still reaches the
 * server under the name the server advertised.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_search_server.mjs', import.meta.url),
);

/** A throwaway tool context; the MCP tool only reads its abort signal. */
const toolContext = {} as unknown as Context;

function isDeclaredTool(tool: ToolUnion): tool is Tool {
  return 'functionDeclarations' in tool;
}

function declaredToolNames(llmRequest: LlmRequest): (string | undefined)[] {
  const tools = llmRequest.config?.tools ?? [];
  return tools
    .filter(isDeclaredTool)
    .flatMap((tool) => tool.functionDeclarations ?? [])
    .map((declaration) => declaration.name);
}

function createToolset(label: string): MCPToolset {
  return new MCPToolset(
    {
      type: 'StdioConnectionParams',
      serverParams: {command: process.execPath, args: [SERVER_PATH, label]},
    },
    [],
    label,
  );
}

describe('MCPToolset prefixing (e2e, real MCP servers over stdio)', () => {
  const toolsets: MCPToolset[] = [];

  afterEach(async () => {
    await Promise.all(toolsets.splice(0).map((toolset) => toolset.close()));
  });

  it('exposes two colliding tools under distinct names and dispatches each one', async () => {
    const docsToolset = createToolset('docs');
    const webToolset = createToolset('web');
    toolsets.push(docsToolset, webToolset);

    const docsTools = await docsToolset.getToolsWithPrefix();
    const webTools = await webToolset.getToolsWithPrefix();

    expect(docsTools.map((tool) => tool.name)).toEqual(['docs_search']);
    expect(webTools.map((tool) => tool.name)).toEqual(['web_search']);

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    for (const tool of [...docsTools, ...webTools]) {
      await tool.processLlmRequest({toolContext, llmRequest});
    }

    expect(Object.keys(llmRequest.toolsDict)).toEqual([
      'docs_search',
      'web_search',
    ]);
    expect(declaredToolNames(llmRequest)).toEqual([
      'docs_search',
      'web_search',
    ]);

    const docsResult = await llmRequest.toolsDict['docs_search'].runAsync({
      args: {query: 'adk'},
      toolContext,
    });
    const webResult = await llmRequest.toolsDict['web_search'].runAsync({
      args: {query: 'adk'},
      toolContext,
    });

    expect(docsResult).toMatchObject({
      content: [{text: 'docs answered adk'}],
    });
    expect(webResult).toMatchObject({
      content: [{text: 'web answered adk'}],
    });
  });

  it('leaves the unprefixed toolset names alone', async () => {
    const toolset = new MCPToolset({
      type: 'StdioConnectionParams',
      serverParams: {command: process.execPath, args: [SERVER_PATH, 'docs']},
    });
    toolsets.push(toolset);

    const tools = await toolset.getToolsWithPrefix();

    expect(tools.map((tool) => tool.name)).toEqual(['search']);
    expect(tools[0]._getDeclaration()?.name).toBe('search');
  });
});
