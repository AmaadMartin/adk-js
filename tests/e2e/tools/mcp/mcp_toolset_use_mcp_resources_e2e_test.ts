/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LoadMcpResourceTool, MCPToolset} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks for the `useMcpResources` flag: a real
 * `MCPToolset` talks to a real MCP server (spawned as a stdio child process, see
 * `mcp_toolset_resources_server.mjs`) that advertises two tools (`echo`, `ping`)
 * and one resource (`readme`). This proves that `getTools()` appends a real,
 * working `load_mcp_resource` tool after tool discovery when the flag is set —
 * against an actual MCP server, not test doubles. The default/filter/prefix
 * behaviors are pure wiring and are covered by the unit tests.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_toolset_resources_server.mjs', import.meta.url),
);

describe('MCPToolset useMcpResources (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;

  afterEach(async () => {
    await toolset?.close();
  });

  it('appends a real load_mcp_resource tool after the discovered tools', async () => {
    toolset = new MCPToolset(
      {
        type: 'StdioConnectionParams',
        serverParams: {command: process.execPath, args: [SERVER_PATH]},
      },
      [],
      undefined,
      true,
    );

    const tools = await toolset.getTools();

    // The two discovered tools come first, in either order, then the resource
    // tool as the final element.
    expect(tools).toHaveLength(3);
    expect(
      tools
        .slice(0, 2)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['echo', 'ping']);

    const last = tools.at(-1)!;
    expect(last.name).toBe('load_mcp_resource');
    expect(last).toBeInstanceOf(LoadMcpResourceTool);

    // The appended tool is backed by the same live toolset, so it can reach the
    // real server's resources — proving it is genuinely wired, not a stub.
    expect(await toolset.listResources()).toContain('readme');
  });
});
