/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPSessionManager, MCPTool} from '@google/adk';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it} from 'vitest';

const sessionManager = new MCPSessionManager({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost/unused',
});

/** An MCP tool declaring `meta`, which only a remote server populates. */
function toolWithMeta(meta: Record<string, unknown>): Tool {
  return {
    name: 'weather',
    description: 'Reports the weather.',
    inputSchema: {type: 'object', properties: {}},
    _meta: meta,
  };
}

/**
 * A tool definition as the transport hands it back: parsed JSON, so a field
 * can hold a shape the `Tool` type does not allow.
 */
function toolFromWire(json: string): Tool {
  return JSON.parse(json);
}

describe('MCPTool.visibility', () => {
  it('returns the audiences the server declares', () => {
    const tool = new MCPTool(
      toolWithMeta({ui: {visibility: ['app', 'debug']}}),
      sessionManager,
    );

    expect(tool.visibility).toEqual(['app', 'debug']);
  });

  it('returns an empty list when the tool declares no meta', () => {
    const tool = new MCPTool(
      {
        name: 'weather',
        description: 'Reports the weather.',
        inputSchema: {type: 'object', properties: {}},
      },
      sessionManager,
    );

    expect(tool.visibility).toEqual([]);
  });

  it('returns an empty list when meta is not an object', () => {
    const tool = new MCPTool(
      toolFromWire(
        '{"name":"weather","description":"d","inputSchema":{"type":"object"},"_meta":"nope"}',
      ),
      sessionManager,
    );

    expect(tool.visibility).toEqual([]);
  });

  it('returns an empty list when meta declares no ui block', () => {
    const tool = new MCPTool(toolWithMeta({}), sessionManager);

    expect(tool.visibility).toEqual([]);
  });

  it('returns an empty list when the ui block is not an object', () => {
    const tool = new MCPTool(toolWithMeta({ui: 'nope'}), sessionManager);

    expect(tool.visibility).toEqual([]);
  });

  it('returns an empty list when the ui block declares no visibility', () => {
    const tool = new MCPTool(
      toolWithMeta({ui: {resourceUri: 'ui://weather/card'}}),
      sessionManager,
    );

    expect(tool.visibility).toEqual([]);
  });

  it('returns an empty list when visibility is not a list', () => {
    const tool = new MCPTool(
      toolWithMeta({ui: {visibility: 'app'}}),
      sessionManager,
    );

    expect(tool.visibility).toEqual([]);
  });

  it('returns an empty list when visibility holds a value that is not a string', () => {
    const tool = new MCPTool(
      toolWithMeta({ui: {visibility: ['app', 7]}}),
      sessionManager,
    );

    expect(tool.visibility).toEqual([]);
  });
});
