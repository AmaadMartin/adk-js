/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  MCPToolset,
  PluginManager,
  createSession,
} from '@google/adk';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` talks to a real MCP server
 * (spawned as a stdio child process, see `mcp_pooling_server.mjs`). The server
 * records its pid on startup, which proves how many server processes the
 * toolset actually started.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_pooling_server.mjs', import.meta.url),
);

/** Timeout (ms) for the spawned server to exit after the session closes. */
const SERVER_EXIT_TIMEOUT_MS = 5000;

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'mcp-session-pooling-e2e',
      session: createSession({
        id: 'session',
        appName: 'app',
        userId: 'user',
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

/** The pids recorded by the server processes that have started. */
function recordedPids(pidFile: string): number[] {
  return readFileSync(pidFile, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map(Number);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('MCP session pooling (e2e, real MCP server over stdio)', () => {
  let workDir: string;
  let pidFile: string;
  let toolset: MCPToolset;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'adk-mcp-pooling-'));
    pidFile = join(workDir, 'pids');
    writeFileSync(pidFile, '');
    toolset = new MCPToolset({
      type: 'StdioConnectionParams',
      serverParams: {
        command: process.execPath,
        args: [SERVER_PATH],
        env: {MCP_PID_FILE: pidFile},
      },
    });
  });

  afterEach(async () => {
    await toolset.close();
    rmSync(workDir, {recursive: true, force: true});
  });

  it('serves discovery and repeated tool calls from one server process', async () => {
    const tools = await toolset.getTools();

    const first = await tools[0].runAsync({
      args: {},
      toolContext: createToolContext(),
    });
    const second = await tools[0].runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(first).toMatchObject({content: [{type: 'text', text: 'echo-ok'}]});
    expect(second).toMatchObject({content: [{type: 'text', text: 'echo-ok'}]});
    expect(recordedPids(pidFile)).toHaveLength(1);
  });

  it('close ends the pooled server process', async () => {
    const tools = await toolset.getTools();
    await tools[0].runAsync({args: {}, toolContext: createToolContext()});
    const [pid] = recordedPids(pidFile);
    expect(isRunning(pid)).toBe(true);

    await toolset.close();

    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), {
      timeout: SERVER_EXIT_TIMEOUT_MS,
    });
  });
});
