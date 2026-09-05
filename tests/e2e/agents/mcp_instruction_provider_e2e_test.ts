/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createSession,
  InvocationContext,
  MCPConnectionParams,
  mcpInstructionProvider,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: the real `mcpInstructionProvider` drives a
 * real `MCPSessionManager` against a real MCP server (spawned as a stdio child
 * process, see `mcp_prompt_server.mjs`). It needs no credentials and no
 * outbound network.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_prompt_server.mjs', import.meta.url),
);

const CONNECTION_PARAMS: MCPConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: process.execPath, args: [SERVER_PATH]},
};

/** Builds a ReadonlyContext over a real session holding `state`. */
function makeContext(state: Record<string, unknown>): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv_1',
      session: createSession({id: 'sess_1', appName: 'app', state}),
      pluginManager: new PluginManager(),
    }),
  );
}

describe('mcpInstructionProvider (e2e, real MCP server over stdio)', () => {
  it('builds the instruction from a real prompt and sends only declared arguments', async () => {
    const provider = mcpInstructionProvider(
      CONNECTION_PARAMS,
      'support_system_prompt',
    );

    const instruction = await provider(
      makeContext({user_name: 'Ada', unrelated: 'x'}),
    );

    expect(instruction).toBe('You help Ada. Received: {"user_name":"Ada"}');
  });

  it('rejects when the real prompt returns no messages', async () => {
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, 'empty_prompt');

    await expect(provider(makeContext({}))).rejects.toThrow(
      "Failed to load MCP prompt 'empty_prompt'.",
    );
  });
});
