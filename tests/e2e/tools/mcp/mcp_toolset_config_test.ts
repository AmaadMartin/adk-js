/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, MCPToolset} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';

/**
 * End-to-end test with NO mocks: an agent-config-shaped object builds a real
 * `MCPToolset` through `fromConfig`, and that toolset lists the tools of a real
 * MCP server spawned as a stdio child process.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_call_guards_server.mjs', import.meta.url),
);

describe('MCPToolset.fromConfig (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset | undefined;

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
    vi.unstubAllEnvs();
  });

  it('refuses to launch a config-declared stdio server by default', async () => {
    await expect(
      MCPToolset.fromConfig({
        stdioServerParams: {command: process.execPath, args: [SERVER_PATH]},
      }),
    ).rejects.toThrow('not allowed in agent configs');
  });

  it('lists real tools once the operator opts in', async () => {
    vi.stubEnv(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR, '1');
    toolset = await MCPToolset.fromConfig({
      stdioServerParams: {command: process.execPath, args: [SERVER_PATH]},
      prefix: 'srv',
    });

    const names = (await toolset.getTools()).map((tool) => tool.name);

    expect(names).toEqual(['srv_echo']);
  });
});
