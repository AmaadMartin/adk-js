/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPToolset} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * spawned as a stdio child process (see `mcp_call_guards_server.mjs`). It
 * proves the reserved-name skip and the per-call timeout against an actual
 * server rather than against test doubles.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_call_guards_server.mjs', import.meta.url),
);

/** Shorter than the server's 5s `slow` resource, long enough to connect. */
const TIMEOUT_SECONDS = 0.2;

function createToolset(timeout?: number): MCPToolset {
  return new MCPToolset({
    type: 'StdioConnectionParams',
    serverParams: {command: process.execPath, args: [SERVER_PATH]},
    timeout,
  });
}

describe('MCPToolset call guards (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  it('drops the reserved tool the real server advertises', async () => {
    toolset = createToolset();

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).toContain('echo');
    expect(names).not.toContain('transfer_to_agent');
  });

  it('fails a real call that outlives the configured timeout', async () => {
    toolset = createToolset(TIMEOUT_SECONDS);

    await expect(toolset.readResource('slow')).rejects.toThrow(
      'Failed to get resource slow from MCP server: MCP error -32001: Request timed out',
    );
  });
});
