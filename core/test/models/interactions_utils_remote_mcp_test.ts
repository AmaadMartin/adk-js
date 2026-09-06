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
 * Python test names so a reader can find the original.
 *
 * The reference drives resolution through `ManagedAgent._resolve_backend_tools`.
 * adk-js has no `ManagedAgent`, so these run against the three functions that
 * method calls: `buildMcpServerParam`, `resolveRemoteMcpServerHeaders`, and
 * `resolveMcpServerParam`, which chains the other two. A test whose `it()`
 * string is prose is adk-js only: it covers an edge the reference suite does
 * not reach.
 */

import {
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  RemoteMcpServer,
  createSession,
} from '@google/adk';
import {GenerateContentConfig} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  buildMcpServerParam,
  convertToolsConfigToInteractionsFormat,
  resolveMcpServerParam,
} from '../../src/models/interactions_utils.js';
import {resolveRemoteMcpServerHeaders} from '../../src/tools/remote_mcp_server.js';

const DEFAULT_URL = 'https://mcp.example.com/mcp';

function makeServer(options: Partial<RemoteMcpServer> = {}): RemoteMcpServer {
  return {url: DEFAULT_URL, ...options};
}

/** Builds a real ReadonlyContext over a real session and plugin manager. */
function makeContext(userId = 'u-1'): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 's-1', appName: 'app-1', userId}),
      pluginManager: new PluginManager([]),
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
  it('test_minimal_url_only', () => {
    expect(buildMcpServerParam({url: DEFAULT_URL}, {})).toEqual({
      type: 'mcp_server',
      url: DEFAULT_URL,
    });
  });

  it('test_with_name', () => {
    const param = buildMcpServerParam({url: DEFAULT_URL, name: 'maps'}, {});

    expect(param.name).toBe('maps');
  });

  it('test_with_headers', () => {
    const param = buildMcpServerParam(
      {url: DEFAULT_URL},
      {'X-Goog-Api-Key': 'k'},
    );

    expect(param.headers).toEqual({'X-Goog-Api-Key': 'k'});
  });

  it('test_with_allowed_tools', () => {
    const param = buildMcpServerParam(
      {url: DEFAULT_URL, allowedTools: ['search_places']},
      {},
    );

    expect(param.allowed_tools).toEqual([{tools: ['search_places']}]);
  });

  it('test_omits_unset_fields', () => {
    const param = buildMcpServerParam({url: DEFAULT_URL}, {});

    expect(param).not.toHaveProperty('name');
    expect(param).not.toHaveProperty('headers');
    expect(param).not.toHaveProperty('allowed_tools');
  });

  it('forwards an empty name and an empty allowedTools list', () => {
    const param = buildMcpServerParam(
      {url: DEFAULT_URL, name: '', allowedTools: []},
      {},
    );

    expect(param.name).toBe('');
    expect(param.allowed_tools).toEqual([{tools: []}]);
  });

  it('does not alias the spec allowedTools array', () => {
    const server: RemoteMcpServer = {url: DEFAULT_URL, allowedTools: ['a']};

    const param = buildMcpServerParam(server, {});
    param.allowed_tools![0].tools!.push('b');

    expect(server.allowedTools).toEqual(['a']);
  });
});

describe('resolveRemoteMcpServerHeaders', () => {
  it('test_resolve_mcp_basic_mapping', async () => {
    const server: RemoteMcpServer = {
      url: DEFAULT_URL,
      name: 'example',
      allowedTools: ['a'],
    };

    expect(await resolveParam(server)).toEqual({
      type: 'mcp_server',
      url: DEFAULT_URL,
      name: 'example',
      allowed_tools: [{tools: ['a']}],
    });
  });

  it('test_resolve_mcp_sync_header_provider', async () => {
    let called = false;
    const server: RemoteMcpServer = {
      url: 'https://x/mcp',
      headerProvider: () => {
        called = true;
        return {Authorization: 'Bearer tok'};
      },
    };

    const param = await resolveParam(server);

    expect(called).toBe(true);
    expect(param.headers).toEqual({Authorization: 'Bearer tok'});
  });

  it('test_resolve_mcp_async_header_provider', async () => {
    const server: RemoteMcpServer = {
      url: 'https://x/mcp',
      headerProvider: async () => ({Authorization: 'Bearer async'}),
    };

    expect((await resolveParam(server)).headers).toEqual({
      Authorization: 'Bearer async',
    });
  });

  it('test_resolve_mcp_merges_static_and_dynamic_dynamic_wins', async () => {
    const server: RemoteMcpServer = {
      url: 'https://x/mcp',
      headers: {'X-Static': 's', Shared: 'static'},
      headerProvider: () => ({Shared: 'dynamic', 'X-Dyn': 'd'}),
    };

    expect((await resolveParam(server)).headers).toEqual({
      'X-Static': 's',
      Shared: 'dynamic',
      'X-Dyn': 'd',
    });
  });

  it('test_resolve_mcp_no_header_provider_static_only', async () => {
    const server: RemoteMcpServer = {
      url: 'https://x/mcp',
      headers: {'X-Static': 's'},
    };

    expect((await resolveParam(server)).headers).toEqual({'X-Static': 's'});
  });

  it('test_resolve_mcp_header_provider_error_propagates', async () => {
    const server: RemoteMcpServer = {
      url: 'https://x/mcp',
      headerProvider: () => {
        throw new Error('token mint failed');
      },
    };

    await expect(resolveParam(server)).rejects.toThrow('token mint failed');
  });

  it('test_resolve_mcp_mixed_with_builtin', async () => {
    // The reference asserts this through ManagedAgent, which adk-js does not
    // have; here the two params are built by the two functions a ManagedAgent
    // would call and collected into one tool list.
    const config: GenerateContentConfig = {tools: [{googleSearch: {}}]};

    const params = [
      ...convertToolsConfigToInteractionsFormat(config),
      await resolveParam({url: 'https://x/mcp'}),
    ];

    expect(params).toContainEqual({type: 'google_search'});
    expect(params.filter((p) => p.type === 'mcp_server')).toHaveLength(1);
  });

  it('test_resolve_mcp_empty_header_provider_omits_headers', async () => {
    const server: RemoteMcpServer = {
      url: 'https://x/mcp',
      headerProvider: () => ({}),
    };

    expect(await resolveParam(server)).not.toHaveProperty('headers');
  });

  it('test_resolve_mcp_does_not_mutate_spec_headers', async () => {
    const server: RemoteMcpServer = {
      url: 'https://x/mcp',
      headers: {'X-Static': 's'},
      headerProvider: () => ({Authorization: 'Bearer tok'}),
    };

    await resolveParam(server);

    expect(server.headers).toEqual({'X-Static': 's'});
  });

  it('returns an empty record when the server declares no headers', async () => {
    const headers = await resolveRemoteMcpServerHeaders(
      {url: 'https://x/mcp'},
      makeContext(),
    );

    expect(headers).toEqual({});
  });

  it('passes the turn context to the header provider', async () => {
    const context = makeContext('user-42');
    let seen: ReadonlyContext | undefined;
    const server: RemoteMcpServer = {
      url: 'https://x/mcp',
      headerProvider: (ctx: ReadonlyContext) => {
        seen = ctx;
        return {Authorization: `Bearer ${ctx.userId}`};
      },
    };

    const headers = await resolveRemoteMcpServerHeaders(server, context);

    expect(seen).toBe(context);
    expect(headers).toEqual({Authorization: 'Bearer user-42'});
  });
});

describe('resolveMcpServerParam', () => {
  it('test_minimal_url_only', async () => {
    await expect(
      resolveMcpServerParam(makeServer(), makeContext()),
    ).resolves.toEqual({
      type: 'mcp_server',
      url: DEFAULT_URL,
    });
  });

  it('test_with_name', async () => {
    const param = await resolveMcpServerParam(
      makeServer({name: 'maps'}),
      makeContext(),
    );

    expect(param.name).toBe('maps');
  });

  it('test_with_headers', async () => {
    const server = makeServer({headers: {'X-Goog-Api-Key': 'k'}});

    const param = await resolveMcpServerParam(server, makeContext());

    expect(param.headers).toEqual({'X-Goog-Api-Key': 'k'});
  });

  it('test_with_allowed_tools', async () => {
    const server = makeServer({allowedTools: ['search_places']});

    const param = await resolveMcpServerParam(server, makeContext());

    expect(param.allowed_tools).toEqual([{tools: ['search_places']}]);
  });

  it('test_omits_unset_fields', async () => {
    const param = await resolveMcpServerParam(makeServer(), makeContext());

    expect(param).not.toHaveProperty('name');
    expect(param).not.toHaveProperty('headers');
    expect(param).not.toHaveProperty('allowed_tools');
  });

  it('test_resolve_mcp_basic_mapping', async () => {
    const server = makeServer({name: 'example', allowedTools: ['a']});

    await expect(resolveMcpServerParam(server, makeContext())).resolves.toEqual(
      {
        type: 'mcp_server',
        url: DEFAULT_URL,
        name: 'example',
        allowed_tools: [{tools: ['a']}],
      },
    );
  });

  it('test_resolve_mcp_sync_header_provider', async () => {
    let called = false;
    const server = makeServer({
      headerProvider: () => {
        called = true;
        return {Authorization: 'Bearer tok'};
      },
    });

    const param = await resolveMcpServerParam(server, makeContext());

    expect(called).toBe(true);
    expect(param.headers).toEqual({Authorization: 'Bearer tok'});
  });

  it('test_resolve_mcp_async_header_provider', async () => {
    const server = makeServer({
      headerProvider: async () => ({Authorization: 'Bearer async'}),
    });

    const param = await resolveMcpServerParam(server, makeContext());

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

    await resolveMcpServerParam(server, makeContext());

    expect(seenUserId).toBe('u-1');
  });

  it('test_resolve_mcp_merges_static_and_dynamic_dynamic_wins', async () => {
    const server = makeServer({
      headers: {'X-Static': 's', Shared: 'static'},
      headerProvider: () => ({Shared: 'dynamic', 'X-Dyn': 'd'}),
    });

    const param = await resolveMcpServerParam(server, makeContext());

    expect(param.headers).toEqual({
      'X-Static': 's',
      Shared: 'dynamic',
      'X-Dyn': 'd',
    });
  });

  it('test_resolve_mcp_no_header_provider_static_only', async () => {
    const server = makeServer({headers: {'X-Static': 's'}});

    const param = await resolveMcpServerParam(server, makeContext());

    expect(param.headers).toEqual({'X-Static': 's'});
  });

  it('test_resolve_mcp_header_provider_error_propagates', async () => {
    const server = makeServer({
      headerProvider: () => {
        throw new Error('token mint failed');
      },
    });

    await expect(resolveMcpServerParam(server, makeContext())).rejects.toThrow(
      'token mint failed',
    );
  });

  it('test_resolve_mcp_empty_header_provider_omits_headers', async () => {
    const server = makeServer({headerProvider: () => ({})});

    const param = await resolveMcpServerParam(server, makeContext());

    expect(param).not.toHaveProperty('headers');
  });

  it('test_resolve_mcp_does_not_mutate_spec_headers', async () => {
    const originalHeaders = {'X-Static': 's'};
    const server = makeServer({
      headers: originalHeaders,
      headerProvider: () => ({Authorization: 'Bearer tok'}),
    });

    await resolveMcpServerParam(server, makeContext());

    expect(server.headers).toEqual({'X-Static': 's'});
    expect(originalHeaders).toEqual({'X-Static': 's'});
  });

  it('carries every field of a fully populated spec', async () => {
    const server: RemoteMcpServer = {
      url: DEFAULT_URL,
      name: 'example',
      headers: {'X-Static': 'v'},
      allowedTools: ['a', 'b'],
      headerProvider: () => ({Authorization: 'Bearer t'}),
    };

    await expect(resolveMcpServerParam(server, makeContext())).resolves.toEqual(
      {
        type: 'mcp_server',
        url: DEFAULT_URL,
        name: 'example',
        headers: {'X-Static': 'v', Authorization: 'Bearer t'},
        allowed_tools: [{tools: ['a', 'b']}],
      },
    );
  });

  it('emits an empty allowed_tools list and an empty name', async () => {
    const server = makeServer({name: '', allowedTools: []});

    await expect(resolveMcpServerParam(server, makeContext())).resolves.toEqual(
      {
        type: 'mcp_server',
        url: DEFAULT_URL,
        name: '',
        allowed_tools: [{tools: []}],
      },
    );
  });

  it('does not alias the spec allowedTools array', async () => {
    const server = makeServer({allowedTools: ['a']});

    const param = await resolveMcpServerParam(server, makeContext());
    expect(param.allowed_tools).toEqual([{tools: ['a']}]);
    param.allowed_tools?.[0].tools?.push('b');

    expect(server.allowedTools).toEqual(['a']);
  });
});
