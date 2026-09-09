/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MCPConnectionParams,
  MCPSessionManager,
  mergeConnectionHeaders,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {describe, expect, it, vi} from 'vitest';
// The logger singleton is internal (not part of the public API), so it is
// imported via a relative path to spy on the exact instance the manager uses.
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

  describe('per-call headers', () => {
    it('test_merge_headers_stdio', () => {
      const merged = mergeConnectionHeaders(
        {
          type: 'StdioConnectionParams',
          serverParams: {command: 'test-command'},
        },
        {Authorization: 'Bearer token'},
      );

      expect(merged).toBeUndefined();
    });

    it('test_merge_headers_streamable_http', () => {
      const merged = mergeConnectionHeaders(
        {
          type: 'StreamableHTTPConnectionParams',
          url: 'http://test-url',
          transportOptions: {requestInit: {headers: {'x-static': 'static'}}},
        },
        {Authorization: 'Bearer token'},
      );

      expect(merged).toEqual({
        'x-static': 'static',
        Authorization: 'Bearer token',
      });
    });

    it('lets a per-call header override a static one of the same name', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {headers: {Authorization: 'Bearer static'}},
        },
      });

      await manager.createSession({Authorization: 'Bearer per-call'});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {requestInit: {headers: {Authorization: 'Bearer per-call'}}},
      );
    });

    it('keeps static headers with a different name', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {'x-tenant': 'acme'}}},
      });

      await manager.createSession({Authorization: 'Bearer per-call'});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          requestInit: {
            headers: {'x-tenant': 'acme', Authorization: 'Bearer per-call'},
          },
        },
      );
    });

    it('keeps the rest of requestInit when adding a per-call header', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {cache: 'no-store'}},
      });

      await manager.createSession({Authorization: 'Bearer per-call'});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          requestInit: {
            cache: 'no-store',
            headers: {Authorization: 'Bearer per-call'},
          },
        },
      );
    });

    it('merges a per-call header over the deprecated header field', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        header: {'x-tenant': 'acme'},
      });

      await manager.createSession({Authorization: 'Bearer per-call'});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          requestInit: {
            headers: {'x-tenant': 'acme', Authorization: 'Bearer per-call'},
          },
        },
      );
    });

    it('sends no headers to a stdio transport', async () => {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      await manager.createSession({Authorization: 'Bearer per-call'});

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'test-command',
      });
    });

    it('keeps static headers given as a Headers instance', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {headers: new Headers({'x-tenant': 'acme'})},
        },
      });

      await manager.createSession({Authorization: 'Bearer per-call'});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          requestInit: {
            headers: {'x-tenant': 'acme', Authorization: 'Bearer per-call'},
          },
        },
      );
    });

    it('keeps static headers given as an entry array', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: [['x-tenant', 'acme']]}},
      });

      await manager.createSession({Authorization: 'Bearer per-call'});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          requestInit: {
            headers: {'x-tenant': 'acme', Authorization: 'Bearer per-call'},
          },
        },
      );
    });

    it('does not mutate the connection params it was constructed with', async () => {
      const connectionParams: MCPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {'x-tenant': 'acme'}}},
      };
      const snapshot = structuredClone(connectionParams);
      const manager = new MCPSessionManager(connectionParams);

      await manager.createSession({Authorization: 'Bearer first'});
      await manager.createSession({Authorization: 'Bearer second'});

      expect(connectionParams).toEqual(snapshot);
      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          requestInit: {
            headers: {'x-tenant': 'acme', Authorization: 'Bearer second'},
          },
        },
      );
    });
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
