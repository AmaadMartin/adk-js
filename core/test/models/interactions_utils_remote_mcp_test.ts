/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python at commit
 * a3bd11152db6562054db1c509ec44509436d99e7:
 * `tests/unittests/models/test_interactions_utils.py`
 * (`class TestBuildMcpServerParam`) and the `test_resolve_mcp_*` tests in
 * `tests/unittests/agents/test_managed_agent.py`. The `it()` strings keep the
 * Python test names.
 *
 * The reference drives resolution through `ManagedAgent._resolve_backend_tools`.
 * adk-js has no `ManagedAgent`, so these run against
 * `resolveRemoteMcpServerHeaders` and `buildMcpServerParam`, which is what that
 * method calls.
 */

import {
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  RemoteMcpServer,
  createRemoteMcpServer,
  createSession,
  resolveRemoteMcpServerHeaders,
} from '@google/adk';
import {GenerateContentConfig} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  buildMcpServerParam,
  convertToolsConfigToInteractionsFormat,
} from '../../src/models/interactions_utils.js';

/** Builds a real ReadonlyContext over a real session and plugin manager. */
function makeContext(userId = 'user-1'): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'sess-1', appName: 'app', userId}),
      pluginManager: new PluginManager(),
    }),
  );
}

/** Resolves a server the way `_resolve_backend_tools` does, for one turn. */
async function resolveParam(server: RemoteMcpServer, context = makeContext()) {
  return buildMcpServerParam(
    server,
    await resolveRemoteMcpServerHeaders(server, context),
  );
}

describe('buildMcpServerParam', () => {
  const server = () =>
    createRemoteMcpServer({url: 'https://mcp.example.com/mcp'});

  it('test_minimal_url_only', () => {
    expect(buildMcpServerParam(server(), {})).toEqual({
      type: 'mcp_server',
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('test_with_name', () => {
    const param = buildMcpServerParam(
      createRemoteMcpServer({url: 'https://mcp.example.com/mcp', name: 'maps'}),
      {},
    );

    expect(param.name).toBe('maps');
  });

  it('test_with_headers', () => {
    const param = buildMcpServerParam(server(), {'X-Goog-Api-Key': 'k'});

    expect(param.headers).toEqual({'X-Goog-Api-Key': 'k'});
  });

  it('test_with_allowed_tools', () => {
    const param = buildMcpServerParam(
      createRemoteMcpServer({
        url: 'https://mcp.example.com/mcp',
        allowedTools: ['search_places'],
      }),
      {},
    );

    expect(param.allowed_tools).toEqual([{tools: ['search_places']}]);
  });

  it('test_omits_unset_fields', () => {
    const param = buildMcpServerParam(server(), {});

    expect(param).not.toHaveProperty('name');
    expect(param).not.toHaveProperty('headers');
    expect(param).not.toHaveProperty('allowed_tools');
  });

  it('forwards an empty name and an empty allowedTools list', () => {
    const param = buildMcpServerParam(
      createRemoteMcpServer({
        url: 'https://mcp.example.com/mcp',
        name: '',
        allowedTools: [],
      }),
      {},
    );

    expect(param.name).toBe('');
    expect(param.allowed_tools).toEqual([{tools: []}]);
  });

  it('does not alias the description allowedTools array', () => {
    const spec = createRemoteMcpServer({
      url: 'https://mcp.example.com/mcp',
      allowedTools: ['a'],
    });

    const param = buildMcpServerParam(spec, {});
    param.allowed_tools![0].tools!.push('b');

    expect(spec.allowedTools).toEqual(['a']);
  });
});

describe('resolveRemoteMcpServerHeaders', () => {
  it('test_resolve_mcp_basic_mapping', async () => {
    const server = createRemoteMcpServer({
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      allowedTools: ['a'],
    });

    expect(await resolveParam(server)).toEqual({
      type: 'mcp_server',
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      allowed_tools: [{tools: ['a']}],
    });
  });

  it('test_resolve_mcp_sync_header_provider', async () => {
    let called = false;
    const server = createRemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: () => {
        called = true;
        return {Authorization: 'Bearer tok'};
      },
    });

    const param = await resolveParam(server);

    expect(called).toBe(true);
    expect(param.headers).toEqual({Authorization: 'Bearer tok'});
  });

  it('test_resolve_mcp_async_header_provider', async () => {
    const server = createRemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: async () => ({Authorization: 'Bearer async'}),
    });

    expect((await resolveParam(server)).headers).toEqual({
      Authorization: 'Bearer async',
    });
  });

  it('test_resolve_mcp_merges_static_and_dynamic_dynamic_wins', async () => {
    const server = createRemoteMcpServer({
      url: 'https://x/mcp',
      headers: {'X-Static': 's', Shared: 'static'},
      headerProvider: () => ({Shared: 'dynamic', 'X-Dyn': 'd'}),
    });

    expect((await resolveParam(server)).headers).toEqual({
      'X-Static': 's',
      Shared: 'dynamic',
      'X-Dyn': 'd',
    });
  });

  it('test_resolve_mcp_no_header_provider_static_only', async () => {
    const server = createRemoteMcpServer({
      url: 'https://x/mcp',
      headers: {'X-Static': 's'},
    });

    expect((await resolveParam(server)).headers).toEqual({'X-Static': 's'});
  });

  it('test_resolve_mcp_header_provider_error_propagates', async () => {
    const server = createRemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: () => {
        throw new Error('token mint failed');
      },
    });

    await expect(resolveParam(server)).rejects.toThrow('token mint failed');
  });

  it('test_resolve_mcp_mixed_with_builtin', async () => {
    // The reference asserts this through ManagedAgent, which adk-js does not
    // have; here the two params are built by the two functions a ManagedAgent
    // would call and collected into one tool list.
    const config: GenerateContentConfig = {tools: [{googleSearch: {}}]};
    const server = createRemoteMcpServer({url: 'https://x/mcp'});

    const params = [
      ...convertToolsConfigToInteractionsFormat(config),
      await resolveParam(server),
    ];

    expect(params).toContainEqual({type: 'google_search'});
    expect(params.filter((p) => p.type === 'mcp_server')).toHaveLength(1);
  });

  it('test_resolve_mcp_empty_header_provider_omits_headers', async () => {
    const server = createRemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: () => ({}),
    });

    expect(await resolveParam(server)).not.toHaveProperty('headers');
  });

  it('test_resolve_mcp_does_not_mutate_spec_headers', async () => {
    const server = createRemoteMcpServer({
      url: 'https://x/mcp',
      headers: {'X-Static': 's'},
      headerProvider: () => ({Authorization: 'Bearer tok'}),
    });

    await resolveParam(server);

    expect(server.headers).toEqual({'X-Static': 's'});
  });

  it('returns an empty record when the server declares no headers', async () => {
    const server = createRemoteMcpServer({url: 'https://x/mcp'});

    expect(await resolveRemoteMcpServerHeaders(server, makeContext())).toEqual(
      {},
    );
  });

  it('passes the turn context to the header provider', async () => {
    const context = makeContext('user-42');
    let seen: ReadonlyContext | undefined;
    const server = createRemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: (ctx: ReadonlyContext) => {
        seen = ctx;
        return {Authorization: `Bearer ${ctx.userId}`};
      },
    });

    const headers = await resolveRemoteMcpServerHeaders(server, context);

    expect(seen).toBe(context);
    expect(headers).toEqual({Authorization: 'Bearer user-42'});
  });
});
