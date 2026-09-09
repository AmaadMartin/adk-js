/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  McpConnectionError,
  MCPToolset,
  PluginManager,
} from '@google/adk';
import {Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` spawns a real MCP server
 * over stdio (see `mcp_errlog_server.mjs`) with an `errlog` stream attached.
 * It proves that resources still round-trip while stderr is piped, and that
 * the server's own stderr reaches the stream.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_errlog_server.mjs', import.meta.url),
);

/** Written to stderr by the fixture server once it is connected. */
const STDERR_BANNER = 'e2e-errlog-server: ready';

/** Written to stderr by the fixture server while the `ping` tool runs. */
const STDERR_TOOL_LINE = 'e2e-errlog-server: ping called';

/** Milliseconds to wait for the child process to flush its stderr. */
const STDERR_FLUSH_TIMEOUT_MS = 5000;

/** A writable stream that keeps everything written to it. */
function capturingStream(): {stream: Writable; text: () => string} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {stream, text: () => chunks.join('')};
}

/** Resolves once `contains` appears in the captured text, or times out. */
async function waitForText(
  text: () => string,
  contains: string,
): Promise<void> {
  const deadline = Date.now() + STDERR_FLUSH_TIMEOUT_MS;
  while (!text().includes(contains)) {
    if (Date.now() > deadline) {
      expect.fail(`timed out waiting for '${contains}' in: ${text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A tool context with the minimum an MCP tool call reads from it. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'e2e-invocation',
      session: createSession({id: 's1', appName: 'app', userId: 'user'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('MCPToolset errlog (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset | undefined;

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
  });

  it('reads resources and forwards the server stderr to errlog', async () => {
    const errlog = capturingStream();
    toolset = new MCPToolset(
      {
        type: 'StdioConnectionParams',
        serverParams: {command: process.execPath, args: [SERVER_PATH]},
      },
      [],
      undefined,
      {errlog: errlog.stream},
    );

    const names = await toolset.listResources();
    const contents = await toolset.readResource('greeting');

    expect(names).toEqual(['greeting']);
    expect(contents).toEqual([
      {uri: 'file:///greeting.txt', mimeType: 'text/plain', text: 'hello'},
    ]);
    await waitForText(errlog.text, STDERR_BANNER);
  });

  it('forwards the server stderr while a tool runs', async () => {
    const errlog = capturingStream();
    toolset = new MCPToolset(
      {
        type: 'StdioConnectionParams',
        serverParams: {command: process.execPath, args: [SERVER_PATH]},
      },
      [],
      undefined,
      {errlog: errlog.stream},
    );
    const tools = await toolset.getTools();
    const ping = tools.find((tool) => tool.name === 'ping');
    if (ping === undefined) {
      expect.fail(`the fixture server advertised no ping tool: ${tools}`);
    }

    await ping.runAsync({args: {}, toolContext: createToolContext()});

    await waitForText(errlog.text, STDERR_TOOL_LINE);
  });

  it('names the failed operation when the server command does not exist', async () => {
    toolset = new MCPToolset({
      type: 'StdioConnectionParams',
      serverParams: {command: 'adk-no-such-mcp-server-binary'},
    });

    const error = await toolset.getTools().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(McpConnectionError);
    expect((error as Error).message).toContain(
      'Failed to get tools from MCP server',
    );
    expect((error as Error).cause).toBeDefined();
  });
});
