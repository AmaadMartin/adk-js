/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPSessionManager, MCPTool} from '@google/adk';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it} from 'vitest';

/** A real session manager; these tests never open a session with it. */
const sessionManager = new MCPSessionManager({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:1/mcp',
});

function toolWithMeta(meta: Tool['_meta']): MCPTool {
  const mcpTool: Tool = {
    name: 'weather',
    description: 'Reports the weather.',
    inputSchema: {type: 'object', properties: {}},
    _meta: meta,
  };
  return new MCPTool(mcpTool, sessionManager);
}

describe('MCPTool.visibility', () => {
  it('reads the list an MCP App declares under _meta.ui.visibility', () => {
    expect(
      toolWithMeta({ui: {visibility: ['app', 'debug']}}).visibility,
    ).toEqual(['app', 'debug']);
  });

  it('is empty when the server declares no _meta', () => {
    expect(toolWithMeta(undefined).visibility).toEqual([]);
  });

  it('is empty when _meta declares no ui block', () => {
    expect(toolWithMeta({other: 'value'}).visibility).toEqual([]);
  });

  it('is empty when ui is not an object', () => {
    expect(toolWithMeta({ui: 'app'}).visibility).toEqual([]);
    expect(toolWithMeta({ui: null}).visibility).toEqual([]);
    expect(toolWithMeta({ui: ['app']}).visibility).toEqual([]);
  });

  it('is empty when ui declares no visibility', () => {
    expect(
      toolWithMeta({ui: {resourceUri: 'ui://weather'}}).visibility,
    ).toEqual([]);
  });

  it('is empty when visibility is not a list', () => {
    expect(toolWithMeta({ui: {visibility: 'app'}}).visibility).toEqual([]);
  });

  it('is empty when the list holds anything other than strings', () => {
    expect(toolWithMeta({ui: {visibility: ['app', 7]}}).visibility).toEqual([]);
  });

  it('is empty for an empty declared list', () => {
    expect(toolWithMeta({ui: {visibility: []}}).visibility).toEqual([]);
  });
});
