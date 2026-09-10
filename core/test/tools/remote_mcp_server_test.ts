/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/agents/test_managed_agent.py` at commit
 * a3bd11152db6562054db1c509ec44509436d99e7. The `it()` string keeps the Python
 * test name.
 */

import {
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  RemoteMcpServer,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {buildMcpServerParam} from '../../src/models/interactions_utils.js';
import {resolveRemoteMcpServerHeaders} from '../../src/tools/remote_mcp_server.js';

describe('RemoteMcpServer', () => {
  it('test_remote_mcp_server_constructs_and_is_exported', async () => {
    const server: RemoteMcpServer = {
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      headers: {'X-Static': 'v'},
      allowedTools: ['a', 'b'],
      headerProvider: () => ({Authorization: 'Bearer t'}),
    };
    const context = new ReadonlyContext(
      new InvocationContext({
        invocationId: 'inv-1',
        session: createSession({
          id: 'sess-1',
          appName: 'app',
          userId: 'user-1',
        }),
        pluginManager: new PluginManager(),
      }),
    );

    const headers = await resolveRemoteMcpServerHeaders(server, context);

    // The reference asserts the export through `google.adk.tools.__all__`; the
    // adk-js equivalent is that the type imports from the public entry point
    // and that all five fields reach the wire param.
    expect(buildMcpServerParam(server, headers)).toEqual({
      type: 'mcp_server',
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      headers: {'X-Static': 'v', Authorization: 'Bearer t'},
      allowed_tools: [{tools: ['a', 'b']}],
    });
  });
});
