/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPConnectionParams, MCPSessionManager} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {describe, expect, it, vi} from 'vitest';
import {clientStub} from './client_stub.js';
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

const STDIO_PARAMS: MCPConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test-command'},
};

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

    expect(client2).toBe(client1);
    expect(manager.getActiveSessions()).toEqual([client1]);

    await manager.closeSession(client1);
    expect(manager.getActiveSessions()).toEqual([]);
  });

  describe('session pooling', () => {
    it('reuses a pooled session across createSession calls', async () => {
      vi.mocked(StdioClientTransport).mockClear();
      const manager = new MCPSessionManager(STDIO_PARAMS);

      const first = await manager.createSession();
      const second = await manager.createSession();

      expect(second).toBe(first);
      expect(StdioClientTransport).toHaveBeenCalledOnce();
    });

    it('shares one connect across concurrent createSession calls', async () => {
      vi.mocked(StdioClientTransport).mockClear();
      const manager = new MCPSessionManager(STDIO_PARAMS);

      const [first, second] = await Promise.all([
        manager.createSession(),
        manager.createSession(),
      ]);

      expect(second).toBe(first);
      expect(StdioClientTransport).toHaveBeenCalledOnce();
    });

    it('rebuilds the session after the client reports it closed', async () => {
      vi.mocked(StdioClientTransport).mockClear();
      const manager = new MCPSessionManager(STDIO_PARAMS);

      const first = await manager.createSession();
      first.onclose?.();
      const second = await manager.createSession();

      expect(second).not.toBe(first);
      expect(StdioClientTransport).toHaveBeenCalledTimes(2);
      expect(manager.getActiveSessions()).toEqual([second]);
    });

    it('rebuilds the session after closeSession', async () => {
      vi.mocked(StdioClientTransport).mockClear();
      const manager = new MCPSessionManager(STDIO_PARAMS);

      const first = await manager.createSession();
      await manager.closeSession(first);
      const second = await manager.createSession();

      expect(first.close).toHaveBeenCalledOnce();
      expect(second).not.toBe(first);
      expect(StdioClientTransport).toHaveBeenCalledTimes(2);
      expect(manager.getActiveSessions()).toEqual([second]);
    });

    it('closeSession on an already closed client is a no-op', async () => {
      const manager = new MCPSessionManager(STDIO_PARAMS);

      const client = await manager.createSession();
      await manager.closeSession(client);
      await manager.closeSession(client);

      expect(client.close).toHaveBeenCalledOnce();
      expect(manager.getActiveSessions()).toEqual([]);
    });

    it('does not pool a client whose connect failed', async () => {
      vi.mocked(Client).mockImplementationOnce(() =>
        clientStub({
          connect: vi.fn().mockRejectedValue(new Error('connect refused')),
        }),
      );
      const manager = new MCPSessionManager(STDIO_PARAMS);

      await expect(manager.createSession()).rejects.toThrow(
        'Failed to create MCP session',
      );

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledOnce();
      expect(manager.getActiveSessions()).toEqual([client]);
    });

    it('does not share a pooled session between managers', async () => {
      vi.mocked(StreamableHTTPClientTransport).mockClear();
      const managers = ['first-token', 'second-token'].map(
        (token) =>
          new MCPSessionManager({
            type: 'StreamableHTTPConnectionParams',
            url: 'http://test-url',
            transportOptions: {requestInit: {headers: {authorization: token}}},
          }),
      );

      const clients = await Promise.all(
        managers.map((manager) => manager.createSession()),
      );
      const reused = await managers[0].createSession();

      expect(clients[1]).not.toBe(clients[0]);
      expect(reused).toBe(clients[0]);
      expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(2);
    });

    it('reports the pooled session once in getActiveSessions', async () => {
      const manager = new MCPSessionManager(STDIO_PARAMS);

      await manager.createSession();
      await manager.createSession();

      expect(manager.getActiveSessions()).toHaveLength(1);
    });

    it('drops a session the peer closed from getActiveSessions', async () => {
      const manager = new MCPSessionManager(STDIO_PARAMS);

      const client = await manager.createSession();
      client.onclose?.();

      expect(manager.getActiveSessions()).toEqual([]);
    });
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
