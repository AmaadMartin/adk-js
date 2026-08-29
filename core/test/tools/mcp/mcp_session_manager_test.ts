/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPConnectionParams, MCPSessionManager} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
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

  describe('per-session headers', () => {
    /** The transport options the manager passed to the newest transport. */
    function optionsOfLastTransport() {
      const call = vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1);
      return call?.[1];
    }

    it('puts the session headers on the request', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession({headers: {Authorization: 'Bearer one'}});

      expect(optionsOfLastTransport()?.requestInit?.headers).toEqual({
        authorization: 'Bearer one',
      });
    });

    it('lets the session headers win over the connection headers', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {
            headers: {Authorization: 'Bearer static', 'X-Static': 'kept'},
          },
        },
      });

      await manager.createSession({headers: {Authorization: 'Bearer session'}});

      expect(optionsOfLastTransport()?.requestInit?.headers).toEqual({
        authorization: 'Bearer session',
        'x-static': 'kept',
      });
    });

    it('does not leak one session\u2019s headers into the next', async () => {
      const connectionParams: MCPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {},
      };
      const manager = new MCPSessionManager(connectionParams);

      await manager.createSession({headers: {Authorization: 'Bearer first'}});
      await manager.createSession({headers: {'X-Tenant-Id': 'second'}});

      expect(optionsOfLastTransport()?.requestInit?.headers).toEqual({
        'x-tenant-id': 'second',
      });
      expect(connectionParams.transportOptions).toEqual({});
    });

    it('ignores an empty header map', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession({headers: {}});

      expect(optionsOfLastTransport()?.requestInit).toBeUndefined();
    });

    it('ignores headers on a stdio connection', async () => {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      const client = await manager.createSession({
        headers: {Authorization: 'Bearer one'},
      });

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'test-command',
      });
      expect(client.connect).toHaveBeenCalled();
    });
  });

  describe('runGuarded', () => {
    let errorSpy: MockInstance<typeof logger.error>;

    beforeEach(() => {
      // Every transport failure below logs; keep it out of the test output.
      errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    /** A manager whose newest transport the test can fail on demand. */
    async function guardedSession() {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });
      const client = await manager.createSession();
      const transport = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.instances.at(-1);

      return {
        manager,
        client,
        failTransport(message: string) {
          transport?.onerror?.(new Error(message));
        },
      };
    }

    it('returns what the call returned', async () => {
      const {manager, client} = await guardedSession();

      await expect(
        manager.runGuarded(client, Promise.resolve('tool output')),
      ).resolves.toBe('tool output');
    });

    it('propagates the call\u2019s own error unwrapped', async () => {
      const {manager, client} = await guardedSession();

      await expect(
        manager.runGuarded(client, Promise.reject(new Error('tool exploded'))),
      ).rejects.toThrow('tool exploded');
    });

    it('rejects a pending call when the transport fails', async () => {
      const {manager, client, failTransport} = await guardedSession();
      // A call the SDK would leave pending until its 60s request timeout.
      const guarded = manager.runGuarded(client, new Promise<string>(() => {}));

      failTransport('Error POSTing to endpoint: Forbidden');

      await expect(guarded).rejects.toThrow(
        /MCP session connection lost:.*Forbidden/,
      );
    });

    it('keeps the transport error as the cause', async () => {
      const {manager, client, failTransport} = await guardedSession();
      const guarded = manager.runGuarded(client, new Promise<string>(() => {}));

      failTransport('stream died');

      const error = await guarded.catch((e: unknown) => e);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe('stream died');
    });

    it('rejects at once when the transport already failed', async () => {
      const {manager, client, failTransport} = await guardedSession();
      failTransport('died before the call');

      await expect(
        manager.runGuarded(client, new Promise<string>(() => {})),
      ).rejects.toThrow(/MCP session connection lost:.*died before the call/);
    });

    it('reports only the first transport error', async () => {
      const {manager, client, failTransport} = await guardedSession();
      failTransport('first');
      failTransport('second');

      await expect(
        manager.runGuarded(client, new Promise<string>(() => {})),
      ).rejects.toThrow(/first/);
    });

    it('runs unguarded once the session is closed', async () => {
      const {manager, client, failTransport} = await guardedSession();
      await manager.closeSession(client);

      failTransport('after close');

      await expect(
        manager.runGuarded(client, Promise.resolve('still fine')),
      ).resolves.toBe('still fine');
    });

    it('runs unguarded for a session it did not open', async () => {
      const {manager} = await guardedSession();
      const foreign = new Client({name: 'other', version: '1.0.0'});

      await expect(
        manager.runGuarded(foreign, Promise.resolve('unguarded')),
      ).resolves.toBe('unguarded');
    });

    it('observes the abandoned call so it cannot go unhandled', async () => {
      const {manager, client, failTransport} = await guardedSession();
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      let rejectCall = (_: Error) => {};
      const call = new Promise<string>((_, reject) => {
        rejectCall = reject;
      });

      const guarded = manager.runGuarded(client, call);
      failTransport('gateway closed the stream');
      await expect(guarded).rejects.toThrow('MCP session connection lost');
      // What closing the session does to the request the guard abandoned.
      rejectCall(new Error('Connection closed'));
      await new Promise((resolve) => setImmediate(resolve));

      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });
  });
});
