/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPConnectionParams, MCPSessionManager} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ErrorCode, McpError} from '@modelcontextprotocol/sdk/types.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';
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
  describe('round-trip deadline', () => {
    const TIMEOUT_MS = 5000;

    function stdioParams(timeout?: number): MCPConnectionParams {
      return {
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
        timeout,
      };
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('applies the configured deadline to the stdio handshake', async () => {
      const manager = new MCPSessionManager(stdioParams(TIMEOUT_MS));

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), {
        timeout: TIMEOUT_MS,
      });
    });

    it('applies the configured deadline to the streamable HTTP handshake', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        timeout: TIMEOUT_MS,
      });

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), {
        timeout: TIMEOUT_MS,
      });
    });

    it('leaves the SDK default in force when no deadline is configured', async () => {
      const manager = new MCPSessionManager(stdioParams());

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), {});
    });

    it('reaches neither the transport nor the request for sseReadTimeout', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        sseReadTimeout: 300000,
      });

      const client = await manager.createSession();

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        new URL('http://test-url'),
        {},
      );
      expect(client.connect).toHaveBeenCalledWith(expect.anything(), {});
    });

    it('hands the configured deadline to the call', async () => {
      const manager = new MCPSessionManager(stdioParams(TIMEOUT_MS));
      const call = vi.fn().mockResolvedValue('tools');

      await expect(manager.withTimeout('listTools', call)).resolves.toBe(
        'tools',
      );

      expect(call).toHaveBeenCalledWith({timeout: TIMEOUT_MS});
    });

    it('hands empty options to the call when no deadline is configured', async () => {
      const manager = new MCPSessionManager(stdioParams());
      const call = vi.fn().mockResolvedValue('tools');

      await manager.withTimeout('listTools', call);

      expect(call).toHaveBeenCalledWith({});
    });

    it('names the operation and the deadline when the request times out', async () => {
      const manager = new MCPSessionManager(stdioParams(TIMEOUT_MS));
      const sdkError = new McpError(
        ErrorCode.RequestTimeout,
        'Request timed out',
        {timeout: TIMEOUT_MS},
      );

      const rejection = manager.withTimeout('listTools', () =>
        Promise.reject(sdkError),
      );

      await expect(rejection).rejects.toThrow(
        'MCP listTools timed out after 5000ms',
      );
      await expect(rejection).rejects.toHaveProperty('cause', sdkError);
    });

    it('leaves an SDK timeout untouched when no deadline is configured', async () => {
      const manager = new MCPSessionManager(stdioParams());
      const sdkError = new McpError(
        ErrorCode.RequestTimeout,
        'Request timed out',
      );

      await expect(
        manager.withTimeout('listTools', () => Promise.reject(sdkError)),
      ).rejects.toBe(sdkError);
    });

    const nonTimeoutRejections: Array<[string, unknown]> = [
      ['a plain error', new Error('boom')],
      [
        'an MCP error with another code',
        new McpError(ErrorCode.InvalidParams, 'bad params'),
      ],
      ['a null rejection', null],
      ['a string rejection', 'boom'],
    ];

    it.each(nonTimeoutRejections)(
      'passes %s through untouched',
      async (_label, rejection) => {
        const manager = new MCPSessionManager(stdioParams(TIMEOUT_MS));

        await expect(
          manager.withTimeout('listTools', () => Promise.reject(rejection)),
        ).rejects.toBe(rejection);
      },
    );
  });

  describe('server-side session termination', () => {
    /** The transport instance the most recent session was built on. */
    function lastTransport(): StreamableHTTPClientTransport {
      const transport = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.instances.at(-1);
      if (!transport) expect.fail('no transport was constructed');
      return transport;
    }

    const httpParams = (terminateOnClose?: boolean): MCPConnectionParams => ({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      terminateOnClose,
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('terminates the server session before closing the client by default', async () => {
      const manager = new MCPSessionManager(httpParams());
      const client = await manager.createSession();
      const terminateSession = vi.fn().mockResolvedValue(undefined);
      lastTransport().terminateSession = terminateSession;

      await manager.closeSession(client);

      expect(terminateSession).toHaveBeenCalledTimes(1);
      expect(terminateSession.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(client.close).mock.invocationCallOrder[0],
      );
      expect(manager.getActiveSessions()).toEqual([]);
    });

    it('skips termination when terminateOnClose is false', async () => {
      const manager = new MCPSessionManager(httpParams(false));
      const client = await manager.createSession();
      const terminateSession = vi.fn().mockResolvedValue(undefined);
      lastTransport().terminateSession = terminateSession;

      await manager.closeSession(client);

      expect(terminateSession).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('attempts no termination for a stdio session', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });
      const client = await manager.createSession();

      await manager.closeSession(client);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('closes the client even when the termination request fails', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const manager = new MCPSessionManager(httpParams());
      const client = await manager.createSession();
      lastTransport().terminateSession = vi
        .fn()
        .mockRejectedValue(new Error('DELETE refused'));

      await manager.closeSession(client);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to terminate MCP session'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('DELETE refused'),
      );
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(manager.getActiveSessions()).toEqual([]);
      warnSpy.mockRestore();
    });

    it('ignores a client that is not an active session', async () => {
      const manager = new MCPSessionManager(httpParams());
      const client = await manager.createSession();
      const terminateSession = vi.fn().mockResolvedValue(undefined);
      lastTransport().terminateSession = terminateSession;
      await manager.closeSession(client);

      await manager.closeSession(client);

      expect(terminateSession).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
    });
  });
});
