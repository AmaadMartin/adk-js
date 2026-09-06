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
 * Python test names so a reader can find the original. The last three tests
 * are adk-js only: they cover edges the reference suite does not reach.
 */

import {
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  RemoteMcpServer,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {resolveMcpServerParam} from '../../src/models/interactions_utils.js';

const DEFAULT_URL = 'https://mcp.example.com/mcp';

function makeServer(options: Partial<RemoteMcpServer> = {}): RemoteMcpServer {
  return {url: DEFAULT_URL, ...options};
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
