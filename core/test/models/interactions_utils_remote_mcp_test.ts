/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/models/test_interactions_utils.py::TestBuildMcpServerParam`
 * and the `resolve_mcp_*` tests in
 * `tests/unittests/agents/test_managed_agent.py`. The `it()` strings keep the
 * Python test names so a reader can find the original.
 */

import {
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  RemoteMcpServer,
  RemoteMcpServerOptions,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  buildMcpServerParam,
  resolveRemoteMcpServerParam,
} from '../../src/models/interactions_utils.js';

const DEFAULT_URL = 'https://mcp.example.com/mcp';

function makeServer(
  options: Partial<RemoteMcpServerOptions> = {},
): RemoteMcpServer {
  return new RemoteMcpServer({url: DEFAULT_URL, ...options});
}

function makeContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 's-1', appName: 'app-1', userId: 'u-1'}),
      pluginManager: new PluginManager([]),
    }),
  );
}

describe('buildMcpServerParam', () => {
  it('test_minimal_url_only', () => {
    expect(buildMcpServerParam(makeServer(), {})).toEqual({
      type: 'mcp_server',
      url: DEFAULT_URL,
    });
  });

  it('test_with_name', () => {
    expect(buildMcpServerParam(makeServer({name: 'maps'}), {}).name).toBe(
      'maps',
    );
  });

  it('test_with_headers', () => {
    const param = buildMcpServerParam(makeServer(), {'X-Goog-Api-Key': 'k'});

    expect(param.headers).toEqual({'X-Goog-Api-Key': 'k'});
  });

  it('test_with_allowed_tools', () => {
    const server = makeServer({allowedTools: ['search_places']});

    expect(buildMcpServerParam(server, {}).allowed_tools).toEqual([
      {tools: ['search_places']},
    ]);
  });

  it('test_omits_unset_fields', () => {
    const param = buildMcpServerParam(makeServer(), {});

    expect(param).not.toHaveProperty('name');
    expect(param).not.toHaveProperty('headers');
    expect(param).not.toHaveProperty('allowed_tools');
  });
});

describe('resolveRemoteMcpServerParam', () => {
  it('test_resolve_mcp_basic_mapping', async () => {
    const server = makeServer({name: 'example', allowedTools: ['a']});

    await expect(
      resolveRemoteMcpServerParam(server, makeContext()),
    ).resolves.toEqual({
      type: 'mcp_server',
      url: DEFAULT_URL,
      name: 'example',
      allowed_tools: [{tools: ['a']}],
    });
  });

  it('test_resolve_mcp_sync_header_provider', async () => {
    let called = false;
    const server = makeServer({
      headerProvider: () => {
        called = true;
        return {Authorization: 'Bearer tok'};
      },
    });

    const param = await resolveRemoteMcpServerParam(server, makeContext());

    expect(called).toBe(true);
    expect(param.headers).toEqual({Authorization: 'Bearer tok'});
  });

  it('test_resolve_mcp_async_header_provider', async () => {
    const server = makeServer({
      headerProvider: async () => ({Authorization: 'Bearer async'}),
    });

    const param = await resolveRemoteMcpServerParam(server, makeContext());

    expect(param.headers).toEqual({Authorization: 'Bearer async'});
  });

  it('test_resolve_mcp_header_provider_receives_the_turn_context', async () => {
    let seenUserId: string | undefined;
    const server = makeServer({
      headerProvider: (context) => {
        seenUserId = context.userId;
        return {};
      },
    });

    await resolveRemoteMcpServerParam(server, makeContext());

    expect(seenUserId).toBe('u-1');
  });

  it('test_resolve_mcp_merges_static_and_dynamic_dynamic_wins', async () => {
    const server = makeServer({
      headers: {'X-Static': 's', Shared: 'static'},
      headerProvider: () => ({Shared: 'dynamic', 'X-Dyn': 'd'}),
    });

    const param = await resolveRemoteMcpServerParam(server, makeContext());

    expect(param.headers).toEqual({
      'X-Static': 's',
      Shared: 'dynamic',
      'X-Dyn': 'd',
    });
  });

  it('test_resolve_mcp_no_header_provider_static_only', async () => {
    const server = makeServer({headers: {'X-Static': 's'}});

    const param = await resolveRemoteMcpServerParam(server, makeContext());

    expect(param.headers).toEqual({'X-Static': 's'});
  });

  it('test_resolve_mcp_header_provider_error_propagates', async () => {
    const server = makeServer({
      headerProvider: () => {
        throw new Error('token mint failed');
      },
    });

    await expect(
      resolveRemoteMcpServerParam(server, makeContext()),
    ).rejects.toThrow('token mint failed');
  });

  it('test_resolve_mcp_empty_header_provider_omits_headers', async () => {
    const server = makeServer({headerProvider: () => ({})});

    const param = await resolveRemoteMcpServerParam(server, makeContext());

    expect(param).not.toHaveProperty('headers');
  });

  it('test_resolve_mcp_does_not_mutate_spec_headers', async () => {
    const originalHeaders = {'X-Static': 's'};
    const server = makeServer({
      headers: originalHeaders,
      headerProvider: () => ({Authorization: 'Bearer tok'}),
    });

    await resolveRemoteMcpServerParam(server, makeContext());

    expect(server.headers).toEqual({'X-Static': 's'});
    expect(originalHeaders).toEqual({'X-Static': 's'});
  });
});
