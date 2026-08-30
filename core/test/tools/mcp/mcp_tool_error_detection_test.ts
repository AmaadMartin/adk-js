/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPSessionManager, MCPTool} from '@google/adk';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it} from 'vitest';

const mcpTool: Tool = {
  name: 'weather',
  description: 'Reports the weather.',
  inputSchema: {type: 'object', properties: {}},
};

/** A real session manager; these tests never open a session with it. */
const sessionManager = new MCPSessionManager({
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:1/mcp',
});

function detect(response: unknown): string | undefined {
  return new MCPTool(mcpTool, sessionManager).detectErrorInResponse(response);
}

describe('MCPTool.detectErrorInResponse', () => {
  it('reports MCP_TOOL_ERROR when the server sets isError', () => {
    expect(
      detect({content: [{type: 'text', text: 'boom'}], isError: true}),
    ).toBe('MCP_TOOL_ERROR');
  });

  it('reports no error when the server clears isError', () => {
    expect(detect({content: [], isError: false})).toBeUndefined();
  });

  it('reports no error when the result omits isError', () => {
    expect(detect({content: [{type: 'text', text: 'sunny'}]})).toBeUndefined();
  });

  it('reports no error for a result that is not an object', () => {
    expect(detect(undefined)).toBeUndefined();
    expect(detect(null)).toBeUndefined();
    expect(detect('sunny')).toBeUndefined();
  });
});
