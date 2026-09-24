/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPToolset} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  startStreamableHttpMcpServer,
  type StreamableHttpMcpServer,
} from './mcp_streamable_http_server.js';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * over streamable HTTP. The unit tests prove `terminateSession()` is called;
 * only this test proves the `DELETE` reaches the server.
 */
describe('MCPToolset terminateOnClose (e2e, real MCP server over HTTP)', () => {
  let server: StreamableHttpMcpServer;

  beforeEach(async () => {
    server = await startStreamableHttpMcpServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('sends the session DELETE by default', async () => {
    const toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: server.url,
    });

    const tools = await toolset.getTools();
    await toolset.close();

    expect(tools.map((tool) => tool.name)).toEqual(['ping']);
    expect(server.methods).toContain('DELETE');
  });

  it('sends no session DELETE when terminateOnClose is false', async () => {
    const toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: server.url,
      terminateOnClose: false,
    });

    const tools = await toolset.getTools();
    await toolset.close();

    expect(tools.map((tool) => tool.name)).toEqual(['ping']);
    expect(server.methods).not.toContain('DELETE');
  });

  it('fails to create a session when the timeout is too short', async () => {
    const toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: server.url,
      timeout: 0.001,
    });

    await expect(toolset.getTools()).rejects.toThrow(
      'Failed to create MCP session',
    );
  });
});
