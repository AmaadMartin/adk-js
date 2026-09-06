/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPToolset} from '@google/adk';
import {ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` spawns a real child
 * process that stays alive and never speaks MCP (see `mcp_silent_server.mjs`).
 * The `initialize` handshake therefore never completes, and the only thing that
 * can end the wait is the timeout ADK passes to the MCP SDK. Without that
 * timeout the SDK waits its own 60s default.
 */

const SILENT_SERVER_PATH = fileURLToPath(
  new URL('./mcp_silent_server.mjs', import.meta.url),
);

/** Comfortably below the SDK's 60s default, and above the 0.5s asked for. */
const MAX_ELAPSED_MS = 5000;

describe('MCP stdio timeout (e2e, real unresponsive server)', () => {
  let toolset: MCPToolset | undefined;

  afterEach(async () => {
    await toolset?.close();
    toolset = undefined;
  });

  it('gives up on a server that never answers the handshake', async () => {
    toolset = new MCPToolset({
      type: 'StdioConnectionParams',
      serverParams: {command: process.execPath, args: [SILENT_SERVER_PATH]},
      timeout: 0.5,
    });

    const startedAt = Date.now();
    const failure = await toolset.getTools().then(
      () => undefined,
      (err: unknown) => err,
    );
    const elapsedMs = Date.now() - startedAt;

    if (!(failure instanceof Error)) {
      expect.fail('getTools() resolved against an unresponsive MCP server');
    }
    expect(failure.message).toContain('Failed to create MCP session');
    expect(failure.message).toContain(`MCP error ${ErrorCode.RequestTimeout}`);
    expect(failure.cause).toBeDefined();
    expect(elapsedMs).toBeLessThan(MAX_ELAPSED_MS);
  });
});
