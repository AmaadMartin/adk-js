/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPConnectionParams, MCPToolset, ReadonlyContext} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  clientStub,
  createTestReadonlyContext,
} from './mcp_context_test_utils.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

const httpParams: MCPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'http://test-url/mcp',
};

const TTL_SECONDS = 60;

/** Counts the `tools/list` round trips the toolset actually makes. */
let listTools: ReturnType<typeof vi.fn>;
let context: ReadonlyContext;

describe('MCPToolset tool list cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    context = createTestReadonlyContext();
    listTools = vi.fn().mockResolvedValue({
      tools: [
        {name: 'zebra', description: 'z', inputSchema: {}},
        {name: 'alpha', description: 'a', inputSchema: {}},
      ],
    });
    vi.mocked(Client).mockImplementation(() => clientStub({listTools}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists on every call when no TTL is configured', async () => {
    const toolset = new MCPToolset(httpParams);

    await toolset.getTools();
    await toolset.getTools();

    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('serves the cached list inside the TTL', async () => {
    const toolset = new MCPToolset(httpParams, [], undefined, {
      toolListCacheTtlSeconds: TTL_SECONDS,
    });

    const first = await toolset.getTools();
    const second = await toolset.getTools();

    expect(listTools).toHaveBeenCalledTimes(1);
    expect(second.map((tool) => tool.name)).toEqual(
      first.map((tool) => tool.name),
    );
  });

  it('refetches once the TTL lapses', async () => {
    const toolset = new MCPToolset(httpParams, [], undefined, {
      toolListCacheTtlSeconds: TTL_SECONDS,
    });

    await toolset.getTools();
    vi.advanceTimersByTime(TTL_SECONDS * 1000 + 1);
    await toolset.getTools();

    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('keeps one entry per tenant and serves a returning tenant from cache', async () => {
    let tenant = 'tenant-a';
    const toolset = new MCPToolset(httpParams, [], undefined, {
      toolListCacheTtlSeconds: TTL_SECONDS,
      headerProvider: () => ({'X-Tenant-ID': tenant}),
    });

    await toolset.getTools(context);
    tenant = 'tenant-b';
    await toolset.getTools(context);
    tenant = 'tenant-a';
    await toolset.getTools(context);

    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('ignores the order the header provider returns its headers in', async () => {
    let reversed = false;
    const toolset = new MCPToolset(httpParams, [], undefined, {
      toolListCacheTtlSeconds: TTL_SECONDS,
      headerProvider: () => (reversed ? {b: '2', a: '1'} : {a: '1', b: '2'}),
    });

    await toolset.getTools(context);
    reversed = true;
    await toolset.getTools(context);

    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it('re-runs the filter on a cache hit', async () => {
    let allowed = 'alpha';
    const toolset = new MCPToolset(
      httpParams,
      (tool) => tool.name === allowed,
      undefined,
      {toolListCacheTtlSeconds: TTL_SECONDS},
    );

    const first = await toolset.getTools(context);
    allowed = 'zebra';
    const second = await toolset.getTools(context);

    expect(listTools).toHaveBeenCalledTimes(1);
    expect(first.map((tool) => tool.name)).toEqual(['alpha']);
    expect(second.map((tool) => tool.name)).toEqual(['zebra']);
  });

  it('drops the cache on close', async () => {
    const toolset = new MCPToolset(httpParams, [], undefined, {
      toolListCacheTtlSeconds: TTL_SECONDS,
    });

    await toolset.getTools();
    await toolset.close();
    await toolset.getTools();

    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('drops another tenant expired entry when it caches a new list', async () => {
    let tenant = 'tenant-a';
    const toolset = new MCPToolset(httpParams, [], undefined, {
      toolListCacheTtlSeconds: TTL_SECONDS,
      headerProvider: () => ({'X-Tenant-ID': tenant}),
    });

    await toolset.getTools(context);
    tenant = 'tenant-b';
    await toolset.getTools(context);

    vi.advanceTimersByTime(TTL_SECONDS * 1000 + 1);
    tenant = 'tenant-a';
    await toolset.getTools(context);
    tenant = 'tenant-b';
    await toolset.getTools(context);

    expect(listTools).toHaveBeenCalledTimes(4);
  });

  describe('bounds', () => {
    /** Drives one `getTools()` under a header identity of its own. */
    function tenantToolset(): {
      toolset: MCPToolset;
      fetch: (tenant: string) => Promise<void>;
    } {
      let tenant = '';
      const toolset = new MCPToolset(httpParams, [], undefined, {
        toolListCacheTtlSeconds: TTL_SECONDS,
        headerProvider: () => ({'X-Tenant-ID': tenant}),
      });
      return {
        toolset,
        fetch: async (next: string) => {
          tenant = next;
          await toolset.getTools(context);
        },
      };
    }

    it('holds at 64 entries and evicts the oldest', async () => {
      const {fetch} = tenantToolset();

      for (let i = 0; i < 74; i++) {
        await fetch(`tenant-${i}`);
      }
      expect(listTools).toHaveBeenCalledTimes(74);

      // The last 64 are still cached.
      await fetch('tenant-73');
      expect(listTools).toHaveBeenCalledTimes(74);

      // The first 10 were evicted, so they cost a round trip again.
      await fetch('tenant-0');
      expect(listTools).toHaveBeenCalledTimes(75);
    });

    it('evicts the least recently used entry, not the oldest inserted', async () => {
      const {fetch} = tenantToolset();

      for (let i = 0; i < 64; i++) {
        await fetch(`tenant-${i}`);
      }
      // Touching the first entry makes it the most recently used one.
      await fetch('tenant-0');
      expect(listTools).toHaveBeenCalledTimes(64);

      // One more entry overflows the cap by one.
      await fetch('tenant-64');
      expect(listTools).toHaveBeenCalledTimes(65);

      // The touched entry survived; the one after it was evicted instead.
      await fetch('tenant-0');
      expect(listTools).toHaveBeenCalledTimes(65);
      await fetch('tenant-1');
      expect(listTools).toHaveBeenCalledTimes(66);
    });
  });

  describe('validation', () => {
    it('rejects a TTL of zero', () => {
      expect(
        () =>
          new MCPToolset(httpParams, [], undefined, {
            toolListCacheTtlSeconds: 0,
          }),
      ).toThrow(/must be positive/);
    });

    it('rejects a negative TTL', () => {
      expect(
        () =>
          new MCPToolset(httpParams, [], undefined, {
            toolListCacheTtlSeconds: -1,
          }),
      ).toThrow(/must be positive/);
    });
  });
});
