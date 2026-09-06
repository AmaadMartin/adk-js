/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/agents/test_managed_agent.py` at commit
 * a3bd11152db6562054db1c509ec44509436d99e7. The `it()` strings keep the Python
 * test names.
 */

import {
  InputValidationError,
  RemoteMcpServer,
  createRemoteMcpServer,
  resolveRemoteMcpServerHeaders,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('RemoteMcpServer', () => {
  it('test_remote_mcp_server_constructs_and_is_exported', () => {
    const server = createRemoteMcpServer({
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
    expect(server.headerProvider).toBeTypeOf('function');
    // The Python assertion is on `google.adk.tools.__all__`; the adk-js
    // equivalent is that these symbols import from the public entry point,
    // which this file does.
    expect(createRemoteMcpServer).toBeTypeOf('function');
    expect(resolveRemoteMcpServerHeaders).toBeTypeOf('function');
  });

  it('test_remote_mcp_server_defaults', () => {
    const server = createRemoteMcpServer({url: 'https://x/mcp'});

    expect(server.name).toBeUndefined();
    expect(server.headers).toBeUndefined();
    expect(server.allowedTools).toBeUndefined();
    expect(server.headerProvider).toBeUndefined();
  });

  it('test_remote_mcp_server_forbids_extra_fields', () => {
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', bogus: 'nope'}),
    ).toThrow(InputValidationError);
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', bogus: 'nope'}),
    ).toThrow('RemoteMcpServer does not accept the fields: bogus.');
  });

  it('returns a copy, so a later edit of the argument does not reach it', () => {
    const spec = {
      url: 'https://x/mcp',
      headers: {'X-Static': 's'},
      allowedTools: ['a'],
    };

    const server = createRemoteMcpServer(spec);
    spec.url = 'https://changed/mcp';
    spec.headers['X-Static'] = 'changed';
    spec.allowedTools.push('b');

    expect(server.url).toBe('https://x/mcp');
    expect(server.headers).toEqual({'X-Static': 's'});
    expect(server.allowedTools).toEqual(['a']);
  });

  it('accepts a description typed as RemoteMcpServer', () => {
    const typed: RemoteMcpServer = {url: 'https://x/mcp'};

    expect(createRemoteMcpServer(typed)).toEqual({url: 'https://x/mcp'});
  });
});
