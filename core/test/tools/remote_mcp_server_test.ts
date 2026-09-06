/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/agents/test_managed_agent.py`. The `it()` strings keep the
 * Python test names so a reader can find the original.
 */

import {
  InputValidationError,
  RemoteMcpServer,
  createRemoteMcpServer,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('createRemoteMcpServer', () => {
  it('test_remote_mcp_server_constructs_and_is_exported', () => {
    const headerProvider = () => ({Authorization: 'Bearer t'});

    const server: RemoteMcpServer = createRemoteMcpServer({
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      headers: {'X-Static': 'v'},
      allowedTools: ['a', 'b'],
      headerProvider,
    });

    expect(server.url).toBe('https://mcp.example.com/mcp');
    expect(server.name).toBe('example');
    expect(server.headers).toEqual({'X-Static': 'v'});
    expect(server.allowedTools).toEqual(['a', 'b']);
    expect(server.headerProvider).toBe(headerProvider);
  });

  it('test_remote_mcp_server_defaults', () => {
    const server = createRemoteMcpServer({url: 'https://x/mcp'});

    expect(server.name).toBeUndefined();
    expect(server.headers).toBeUndefined();
    expect(server.allowedTools).toBeUndefined();
    expect(server.headerProvider).toBeUndefined();
  });

  it('test_remote_mcp_server_forbids_extra_fields', () => {
    // Assigned to a variable first: TypeScript rejects an unknown key on a
    // fresh object literal, which is the check this test reaches past.
    const spec = {url: 'https://x/mcp', bogus: 'nope'};

    expect(() => createRemoteMcpServer(spec)).toThrow(InputValidationError);
    expect(() => createRemoteMcpServer(spec)).toThrow('bogus');
  });
});
