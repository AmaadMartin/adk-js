/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MCPConnectionParams,
  MCPSessionManager,
  StreamableHTTPConnectionParams,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
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

  describe('streamable HTTP connection options', () => {
    const STREAM_IDLE_TIMEOUT_SECONDS = 10;

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    /** Options recorded by the most recent transport construction. */
    function lastTransportOptions(): StreamableHTTPClientTransportOptions {
      const options = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.calls.at(-1)?.[1];
      if (!options) expect.fail('the transport was built without options');
      return options;
    }

    /** The transport instance the most recent session was built on. */
    function lastTransport(): StreamableHTTPClientTransport {
      const transport = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.instances.at(-1);
      if (!transport) expect.fail('no transport was constructed');
      return transport;
    }

    /** An event-stream response whose body never produces a chunk. */
    function stalledEventStreamResponse(): Response {
      return new Response(new ReadableStream<Uint8Array>({start() {}}), {
        headers: {'content-type': 'text/event-stream'},
      });
    }

    it('applies the configured connect timeout to the initialize request', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        timeout: 30,
      });

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), {
        timeout: 30000,
      });
    });

    it('leaves the SDK default connect timeout when timeout is unset', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it('ignores a non-positive connect timeout', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        timeout: 0,
      });

      const client = await manager.createSession();

      expect(client.connect).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it('does not install a fetch wrapper when sseReadTimeout is unset', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession();

      expect(lastTransportOptions()).not.toHaveProperty('fetch');
    });

    it('fails a stalled event stream once sseReadTimeout elapses', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(stalledEventStreamResponse()),
      );
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        sseReadTimeout: STREAM_IDLE_TIMEOUT_SECONDS,
      });
      await manager.createSession();

      const wrappedFetch = lastTransportOptions().fetch;
      if (!wrappedFetch) expect.fail('sseReadTimeout installed no fetch');
      const response = await wrappedFetch('http://test-url');
      const body = response.body;
      if (!body) expect.fail('the wrapped response had no body');

      const read = expect(body.getReader().read()).rejects.toThrow(
        'Stream idle for more than 10000 ms',
      );
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_SECONDS * 1000);

      await read;
    });

    it('composes the configured transportOptions.fetch with the idle timeout', async () => {
      const callerFetch = vi.fn().mockResolvedValue(new Response('{}'));
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        sseReadTimeout: STREAM_IDLE_TIMEOUT_SECONDS,
        transportOptions: {fetch: callerFetch},
      });
      await manager.createSession();

      const wrappedFetch = lastTransportOptions().fetch;
      if (!wrappedFetch) expect.fail('sseReadTimeout installed no fetch');
      expect(wrappedFetch).not.toBe(callerFetch);
      await wrappedFetch('http://test-url');

      expect(callerFetch).toHaveBeenCalledTimes(1);
    });

    it('does not wrap the caller options again on a second session', async () => {
      const params: StreamableHTTPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        sseReadTimeout: STREAM_IDLE_TIMEOUT_SECONDS,
        transportOptions: {},
      };
      const manager = new MCPSessionManager(params);

      await manager.createSession();
      await manager.createSession();

      expect(params.transportOptions).toEqual({});
    });

    it('terminates the server session on close when terminateOnClose is set', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        terminateOnClose: true,
      });
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

    it('does not terminate the server session when terminateOnClose is unset', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });
      const client = await manager.createSession();
      const terminateSession = vi.fn().mockResolvedValue(undefined);
      lastTransport().terminateSession = terminateSession;

      await manager.closeSession(client);

      expect(terminateSession).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('closes the client even when the termination request fails', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        terminateOnClose: true,
      });
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

    it('does not attempt a termination request for a stdio session', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });
      const client = await manager.createSession();

      await manager.closeSession(client);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(manager.getActiveSessions()).toEqual([]);
      warnSpy.mockRestore();
    });
  });
});
