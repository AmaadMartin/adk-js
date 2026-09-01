/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LogLevel,
  MCPToolset,
  PluginManager,
  ReadonlyContext,
  setLogLevel,
} from '@google/adk';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` lists the tools of a real
 * MCP server over real HTTP, and the exchanges it made land on the invocation.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_http_debug_server.mjs', import.meta.url),
);

let serverProcess: ChildProcessWithoutNullStreams;
let serverUrl: string;

/** Starts the server and resolves once it reports its port. */
async function startServer(): Promise<void> {
  serverProcess = spawn(process.execPath, [SERVER_PATH]);
  const lines = createInterface({input: serverProcess.stdout});
  for await (const line of lines) {
    const match = /^PORT (\d+)$/.exec(line);
    if (match) {
      serverUrl = `http://127.0.0.1:${match[1]}/mcp`;
      lines.close();
      return;
    }
  }
  expect.fail('the MCP server did not report a port');
}

function createReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'e2e-invocation',
      agent: new LlmAgent({name: 'e2e_agent', model: 'gemini-2.0-flash'}),
      session: createSession({
        id: 'e2e-session',
        appName: 'e2e-app',
        userId: 'e2e-user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
  );
}

describe('MCPToolset HTTP debug capture (e2e, real MCP server over HTTP)', () => {
  let toolset: MCPToolset | undefined;

  beforeAll(startServer);

  afterAll(() => {
    serverProcess.kill();
  });

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
    setLogLevel(LogLevel.INFO);
  });

  it('records the real exchanges on the invocation while debug logging is on', async () => {
    setLogLevel(LogLevel.DEBUG);
    toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: serverUrl,
    });
    const context = createReadonlyContext();

    const names = (await toolset.getTools(context)).map((tool) => tool.name);

    expect(names).toEqual(['echo']);
    const recorded = context.invocationContext.customMetadata[
      'http_debug_info'
    ] as Array<{url: string; status_code: number}>;
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0].url).toBe(serverUrl);
    expect(recorded[0].status_code).toBe(200);
  });

  it('records nothing while debug logging is off', async () => {
    toolset = new MCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: serverUrl,
    });
    const context = createReadonlyContext();

    await toolset.getTools(context);

    expect(context.invocationContext.customMetadata).toEqual({});
  });
});
