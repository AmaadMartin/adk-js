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
    // The implementation mutates `this` rather than returning a literal, so
    // `mock.instances` still yields the object the manager holds.
    StreamableHTTPClientTransport: vi.fn(function (this: {
      terminateSession: () => Promise<void>;
    }) {
      this.terminateSession = vi.fn().mockResolvedValue(undefined);
    }),
  };
});

/** The transport built for the session created most recently. */
function lastHttpTransport(): StreamableHTTPClientTransport {
  const transport = vi
    .mocked(StreamableHTTPClientTransport)
    .mock.instances.at(-1);
  if (!transport) {
    expect.fail('no StreamableHTTPClientTransport was constructed');
  }
  return transport;
}

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

  /**
   * Ported from adk-python
   * `tests/unittests/tools/mcp_tool/test_mcp_session_manager.py` (commit
   * d232e621, "support for streamable http MCP servers for MCPToolset").
   * The Python names are recorded here rather than copied into `it()`, so each
   * description says what the TypeScript test asserts:
   *
   * - `test_init_with_streamable_http_params` -> 'forwards the configured
   *   timeout ...' below.
   * - `terminate_on_close is True` (test_init_with_streamable_http_*_factory)
   *   -> 'terminates the server session before closing the client'.
   * - `test_create_session_bounds_hung_connect` -> 'wraps a connect that
   *   exceeds the configured timeout'.
   *
   * `test_init_with_streamable_http_custom_httpx_factory` and
   * `test_init_with_streamable_http_default_httpx_factory` are not portable:
   * `httpx_client_factory` has no counterpart in the MCP TypeScript SDK, which
   * takes a `fetch` override instead.
   */
  describe('connection options', () => {
    it('forwards the configured timeout to connect as milliseconds', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        timeout: 15,
      });

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), {
        timeout: 15000,
      });
    });

    it('forwards the configured timeout for a stdio session', async () => {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
        timeout: 5,
      });

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), {
        timeout: 5000,
      });
    });

    it('leaves the SDK default in place when no timeout is configured', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it('wraps a connect that exceeds the configured timeout', async () => {
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi
              .fn()
              .mockRejectedValue(
                new Error('MCP error -32001: Request timed out'),
              ),
            close: vi.fn().mockResolvedValue(undefined),
          }) as unknown as Client,
      );

      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        timeout: 1,
      });

      const error = await manager.createSession().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'Failed to create MCP session',
      );
      expect((error as Error).message).toContain('Request timed out');
    });
  });

  describe('session termination', () => {
    it('terminates the server session before closing the client', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const client = await manager.createSession();
      const terminateSession = vi.mocked(lastHttpTransport().terminateSession);

      await manager.closeSession(client);

      expect(terminateSession).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(terminateSession.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(client.close).mock.invocationCallOrder[0],
      );
    });

    it('does not terminate the server session when terminateOnClose is false', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        terminateOnClose: false,
      });

      const client = await manager.createSession();
      const terminateSession = vi.mocked(lastHttpTransport().terminateSession);

      await manager.closeSession(client);

      expect(terminateSession).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('never terminates a stdio session', async () => {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      const client = await manager.createSession();
      await manager.closeSession(client);

      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('closes the client and resolves when termination fails', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const client = await manager.createSession();
      vi.mocked(lastHttpTransport().terminateSession).mockRejectedValue(
        new Error('server refused the delete'),
      );

      await expect(manager.closeSession(client)).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to terminate MCP session'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('server refused the delete'),
      );
      expect(client.close).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it('drops the session from getActiveSessions even when termination fails', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const client = await manager.createSession();
      vi.mocked(lastHttpTransport().terminateSession).mockRejectedValue(
        new Error('server refused the delete'),
      );

      await manager.closeSession(client);

      expect(manager.getActiveSessions()).toEqual([]);
      warnSpy.mockRestore();
    });

    it('is a no-op for a client the manager no longer owns', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const client = await manager.createSession();
      const terminateSession = vi.mocked(lastHttpTransport().terminateSession);

      await manager.closeSession(client);
      await manager.closeSession(client);

      expect(terminateSession).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
    });
  });
});
