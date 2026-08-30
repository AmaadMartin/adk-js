/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPSessionManager, MCPTool} from '@google/adk';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it} from 'vitest';

const mcpTool: Tool = {
  name: 'weather',
  description: 'Reports the weather.',
  inputSchema: {type: 'object', properties: {}},
};

const tool = new MCPTool(
  mcpTool,
  new MCPSessionManager({
    type: 'StreamableHTTPConnectionParams',
    url: 'http://localhost/unused',
  }),
);

describe('MCPTool.detectErrorInResponse', () => {
  it('reports a result the server marked as failed', () => {
    expect(tool.detectErrorInResponse({isError: true, content: []})).toBe(
      'MCP_TOOL_ERROR',
    );
  });

  it('reports nothing for a result the server marked as successful', () => {
    expect(
      tool.detectErrorInResponse({isError: false, content: []}),
    ).toBeUndefined();
  });

  it('reports nothing for a result that omits isError', () => {
    expect(tool.detectErrorInResponse({content: []})).toBeUndefined();
  });

  it('reports nothing for a response that is not an object', () => {
    expect(tool.detectErrorInResponse('boom')).toBeUndefined();
  });

  it('reports nothing for a null response', () => {
    expect(tool.detectErrorInResponse(null)).toBeUndefined();
  });

  it('does not modify the response it inspects', () => {
    const response = {isError: true, content: []};

    tool.detectErrorInResponse(response);

    expect(response).toEqual({isError: true, content: []});
  });
});
