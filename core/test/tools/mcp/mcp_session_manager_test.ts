/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPConnectionParams, MCPSessionManager} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';
// The HTTP debug recorder and the logger singleton are internal (not part of
// the public API), so they are imported via a relative path.
import {
  MAX_HTTP_DEBUG_EXCHANGES,
  McpHttpExchange,
  mcpHttpDebugStorage,
} from '../../../src/tools/mcp/http_debug_recorder.js';
import {logger} from '../../../src/utils/logger.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn(),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn(),
  };
});

describe('MCPSessionManager', () => {
  it('creates an stdio client', async () => {
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {
        command: 'test-command',
        args: ['arg1', 'arg2'],
      },
    });

    const client = await manager.createSession();

    expect(Client).toHaveBeenCalledWith({
      name: 'MCPClient',
      version: '1.0.0',
    });
    expect(StdioClientTransport).toHaveBeenCalledWith({
      command: 'test-command',
      args: ['arg1', 'arg2'],
    });
    expect(client.connect).toHaveBeenCalled();
  });

  it('creates an http client with transport options headers', async () => {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions: {
        requestInit: {
          headers: {
            'x-test-header': 'test-value',
          },
        },
      },
    });

    const client = await manager.createSession();

    expect(Client).toHaveBeenCalledWith({
      name: 'MCPClient',
      version: '1.0.0',
    });
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('http://test-url'),
      {
        requestInit: {
          headers: {'x-test-header': 'test-value'},
        },
      },
    );
    expect(client.connect).toHaveBeenCalled();
  });

  it('creates an http client with deprecated header param', async () => {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      header: {
        'x-test-header': 'test-value',
      },
    });

    await manager.createSession();

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('http://test-url'),
      {
        requestInit: {
          headers: {'x-test-header': 'test-value'},
        },
      },
    );
  });

  it('prioritizes transportOptions headers over header', async () => {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions: {
        requestInit: {
          headers: {
            'x-priority': 'headers',
          },
        },
      },
      header: {
        'x-priority': 'header',
      },
    });

    await manager.createSession();

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      {
        requestInit: {
          headers: {'x-priority': 'headers'},
        },
      },
    );
  });

  it('prioritizes transportOptions over header', async () => {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions: {
        requestInit: {},
      },
      header: {
        'x-priority': 'header',
      },
    });

    await manager.createSession();

    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      {
        requestInit: {},
      },
    );
  });

  it('tracks active sessions and cleans them up', async () => {
    const manager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {
        command: 'test-command',
        args: ['arg1', 'arg2'],
      },
    });

    expect(manager.getActiveSessions()).toEqual([]);

    const client1 = await manager.createSession();
    const client2 = await manager.createSession();

    expect(manager.getActiveSessions()).toEqual([client1, client2]);

    await manager.closeSession(client1);
    expect(manager.getActiveSessions()).toEqual([client2]);

    await manager.closeSession(client2);
    expect(manager.getActiveSessions()).toEqual([]);
  });

  it('does not connect for an unknown connection type', async () => {
    const manager = new MCPSessionManager({
      type: 'UnknownConnectionType',
    } as unknown as MCPConnectionParams);

    const client = await manager.createSession();

    expect(client).toBeDefined();
    expect(client.connect).not.toHaveBeenCalled();
  });

  describe('connection error handling', () => {
    it('wraps a connect failure with a formatted message', async () => {
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi
              .fn()
              .mockRejectedValue(
                Object.assign(
                  new Error(
                    'Streamable HTTP error: Error POSTing to endpoint: Forbidden',
                  ),
                  {code: 403},
                ),
              ),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const error = await manager.createSession().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'Failed to create MCP session',
      );
      expect((error as Error).message).toContain('403');
      expect((error as Error).message).toContain('Forbidden');
    });

    it('preserves the original error as the cause', async () => {
      const original = Object.assign(new Error('boom'), {code: 401});
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockRejectedValue(original),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const error = await manager.createSession().catch((e: unknown) => e);
      expect((error as Error).cause).toBe(original);
    });

    it('wraps an AggregateError connect failure with joined leaves', async () => {
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi
              .fn()
              .mockRejectedValue(
                new AggregateError([new Error('err A'), new Error('err B')]),
              ),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      const error = await manager.createSession().catch((e: unknown) => e);
      const message = (error as Error).message;
      expect(message).toContain('err A');
      expect(message).toContain('err B');
      expect(message).toContain(' | ');
    });

    it('logs a formatted message for a background transport error', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });
      await manager.createSession();

      const transport = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.instances.at(-1);
      expect(transport?.onerror).toBeTypeOf('function');
      transport?.onerror?.(new Error('background stream died'));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('MCP transport error'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('background stream died'),
      );

      errorSpy.mockRestore();
    });
  });
});

describe('MCPSessionManager HTTP debug capture', () => {
  beforeEach(() => {
    vi.mocked(StreamableHTTPClientTransport).mockClear();
  });

  /** The transport options the manager passed on the most recent session. */
  function lastTransportOptions(): StreamableHTTPClientTransportOptions {
    const call = vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1);
    if (!call) {
      expect.fail('StreamableHTTPClientTransport was never constructed');
    }
    return call[1] ?? {};
  }

  /**
   * Creates a session with `baseFetch` configured, under `sink` when given,
   * and returns the `fetch` the manager handed to the transport.
   */
  async function fetchForSession(
    baseFetch: FetchLike | undefined,
    sink?: McpHttpExchange[],
  ): Promise<FetchLike | undefined> {
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions: baseFetch ? {fetch: baseFetch} : {},
    });

    if (sink) {
      await mcpHttpDebugStorage.run(sink, () => manager.createSession());
    } else {
      await manager.createSession();
    }

    return lastTransportOptions().fetch;
  }

  function jsonResponse(status: number): Response {
    return new Response('{}', {
      status,
      headers: {'content-type': 'application/json', 'set-cookie': 'sid=abc'},
    });
  }

  it('records one exchange per request with a sink active', async () => {
    const sink: McpHttpExchange[] = [];
    const baseFetch = vi.fn(async () => jsonResponse(200));

    const wrapped = await fetchForSession(baseFetch, sink);
    const response = await wrapped?.('http://test-url/mcp', {
      method: 'POST',
      headers: {'authorization': 'Bearer secret', 'x-trace': 'keep-me'},
    });

    expect(response?.status).toBe(200);
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({
      url: 'http://test-url/mcp',
      method: 'POST',
      status: 200,
      requestHeaders: {'authorization': '<redacted>', 'x-trace': 'keep-me'},
    });
    expect(sink[0].responseHeaders['set-cookie']).toBe('<redacted>');
    expect(sink[0].responseHeaders['content-type']).toBe('application/json');
    expect(sink[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a non-2xx response', async () => {
    const sink: McpHttpExchange[] = [];

    const wrapped = await fetchForSession(async () => jsonResponse(503), sink);
    const response = await wrapped?.('http://test-url/mcp', {method: 'POST'});

    expect(response?.status).toBe(503);
    expect(sink).toHaveLength(1);
    expect(sink[0].status).toBe(503);
  });

  it('defaults the method to GET when the request does not name one', async () => {
    const sink: McpHttpExchange[] = [];

    const wrapped = await fetchForSession(async () => jsonResponse(200), sink);
    await wrapped?.(new URL('http://test-url/stream'));

    expect(sink[0]).toMatchObject({
      url: 'http://test-url/stream',
      method: 'GET',
      requestHeaders: {},
    });
  });

  it('still invokes a caller-supplied fetch', async () => {
    const sink: McpHttpExchange[] = [];
    const baseFetch = vi.fn(async () => jsonResponse(200));

    const wrapped = await fetchForSession(baseFetch, sink);
    await wrapped?.('http://test-url/mcp', {method: 'POST'});

    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it('propagates a rejection and records nothing for it', async () => {
    const sink: McpHttpExchange[] = [];
    const baseFetch = vi.fn(async () => {
      throw new Error('connection reset');
    });

    const wrapped = await fetchForSession(baseFetch, sink);

    await expect(wrapped?.('http://test-url/mcp')).rejects.toThrow(
      'connection reset',
    );
    expect(sink).toHaveLength(0);
  });

  it('stops recording at MAX_HTTP_DEBUG_EXCHANGES', async () => {
    const sink: McpHttpExchange[] = [];

    const wrapped = await fetchForSession(async () => jsonResponse(200), sink);
    for (let i = 0; i < MAX_HTTP_DEBUG_EXCHANGES + 5; i++) {
      await wrapped?.('http://test-url/mcp', {method: 'POST'});
    }

    expect(sink).toHaveLength(MAX_HTTP_DEBUG_EXCHANGES);
  });

  it('leaves the transport options untouched with no sink active', async () => {
    const baseFetch = vi.fn(async () => jsonResponse(200));

    const wrapped = await fetchForSession(baseFetch);

    expect(wrapped).toBe(baseFetch);
  });

  it('does not add a fetch when the caller configured none', async () => {
    const wrapped = await fetchForSession(undefined);

    expect(wrapped).toBeUndefined();
  });

  it('falls back to the global fetch when the caller configured none', async () => {
    const sink: McpHttpExchange[] = [];
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200));

    const wrapped = await fetchForSession(undefined, sink);
    await wrapped?.('http://test-url/mcp', {method: 'POST'});

    expect(globalFetch).toHaveBeenCalledOnce();
    expect(sink).toHaveLength(1);
    globalFetch.mockRestore();
  });

  it('records an exchange once when the manager opens two sessions', async () => {
    const sink: McpHttpExchange[] = [];
    const transportOptions = {fetch: vi.fn(async () => jsonResponse(200))};
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions,
    });

    await mcpHttpDebugStorage.run(sink, async () => {
      await manager.createSession();
      await manager.createSession();
      await lastTransportOptions().fetch?.('http://test-url/mcp', {
        method: 'POST',
      });
    });

    expect(sink).toHaveLength(1);
  });
});
