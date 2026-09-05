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
  RemoteMcpServerOptions,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('RemoteMcpServer', () => {
  it('test_remote_mcp_server_constructs_and_is_exported', () => {
    const server = new RemoteMcpServer({
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      headers: {'X-Static': 'v'},
      allowedTools: ['a', 'b'],
      headerProvider: () => ({Authorization: 'Bearer t'}),
    });

    expect(server.url).toBe('https://mcp.example.com/mcp');
    expect(server.name).toBe('example');
    expect(server.headers).toEqual({'X-Static': 'v'});
    expect(server.allowedTools).toEqual(['a', 'b']);
    expect(server.headerProvider).toBeDefined();
  });

  it('test_remote_mcp_server_defaults', () => {
    const server = new RemoteMcpServer({url: 'https://x/mcp'});

    expect(server.name).toBeUndefined();
    expect(server.headers).toBeUndefined();
    expect(server.allowedTools).toBeUndefined();
    expect(server.headerProvider).toBeUndefined();
  });

  it('test_remote_mcp_server_forbids_extra_fields', () => {
    const options: RemoteMcpServerOptions = {url: 'https://x/mcp'};
    const widened = {...options, bogus: 'nope'};

    expect(() => new RemoteMcpServer(widened)).toThrow(InputValidationError);
  });
});
