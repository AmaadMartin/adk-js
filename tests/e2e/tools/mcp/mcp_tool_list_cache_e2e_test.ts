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
 * (spawned as a stdio child process, see `mcp_tool_list_server.mjs`). The
 * server names its tool after its own process id, so a second `tools/list`
 * reaches a second process and returns a different name. The name therefore
 * shows whether the round trip happened.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_tool_list_server.mjs', import.meta.url),
);

const TTL_SECONDS = 60;

function createToolset(toolListCacheTtlSeconds?: number): MCPToolset {
  return new MCPToolset(
    {
      type: 'StdioConnectionParams',
      serverParams: {command: process.execPath, args: [SERVER_PATH]},
    },
    [],
    undefined,
    toolListCacheTtlSeconds,
  );
}

describe('MCPToolset tool list cache (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  it('reaches a new server process on every call when no ttl is set', async () => {
    toolset = createToolset();

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(first[0].name).toMatch(/^ping_\d+$/);
    expect(second[0].name).not.toBe(first[0].name);
  });

  it('serves the second call from the cache when a ttl is set', async () => {
    toolset = createToolset(TTL_SECONDS);

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(first[0].name).toMatch(/^ping_\d+$/);
    expect(second[0].name).toBe(first[0].name);
  });

  it('reaches a new server process after close', async () => {
    toolset = createToolset(TTL_SECONDS);

    const first = await toolset.getTools();
    await toolset.close();
    const second = await toolset.getTools();

    expect(second[0].name).not.toBe(first[0].name);
  });
});
