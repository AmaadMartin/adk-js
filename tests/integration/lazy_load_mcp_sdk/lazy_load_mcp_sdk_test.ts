/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {StdioConnectionParams} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

/**
 * Records which MCP SDK modules have been evaluated.
 *
 * Vitest runs a `vi.mock` factory on the first import of the mocked module, so
 * a flag that is still `false` proves nothing has imported that subpath yet.
 */
const loaded = vi.hoisted(() => ({
  client: false,
  stdio: false,
  streamableHttp: false,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  loaded.client = true;
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  loaded.stdio = true;
  return {StdioClientTransport: vi.fn()};
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  loaded.streamableHttp = true;
  return {StreamableHTTPClientTransport: vi.fn()};
});

const STDIO_PARAMS: StdioConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test-command', args: ['arg1']},
};

/**
 * The barrel is imported inside the test bodies. A static import runs at
 * collection time, which would make the first assertion meaningless.
 */
describe('lazy MCP SDK load', () => {
  it('does not load the MCP SDK when the barrel is imported', async () => {
    await import('@google/adk');

    expect(loaded).toEqual({
      client: false,
      stdio: false,
      streamableHttp: false,
    });
  });

  it('loads the MCP SDK on the first createSession()', async () => {
    const {MCPSessionManager} = await import('@google/adk');
    const manager = new MCPSessionManager(STDIO_PARAMS);

    expect(loaded.client).toBe(false);
    const session = await manager.createSession();

    expect(loaded.client).toBe(true);
    expect(loaded.stdio).toBe(true);
    expect(manager.getActiveSessions()).toEqual([session]);
  });

  it('serves a second createSession() from the cached load', async () => {
    const {MCPSessionManager} = await import('@google/adk');
    const manager = new MCPSessionManager(STDIO_PARAMS);

    const first = await manager.createSession();
    const second = await manager.createSession();

    expect(second).not.toBe(first);
    expect(manager.getActiveSessions()).toEqual([first, second]);
  });
});
