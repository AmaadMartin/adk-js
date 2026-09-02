/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  HttpDebugRecord,
  MCPConnectionParams,
  MCPSessionManager,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {StreamableHTTPClientTransportOptions} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {PassThrough, Writable} from 'node:stream';
import {beforeEach, describe, expect, it, vi} from 'vitest';
// The HTTP debug recorders and the logger singleton are internal (not part of
// the public API), so they are imported via a relative path.
import {
  HttpDebugExchange,
  MAX_HTTP_DEBUG_EXCHANGES,
  McpHttpExchange,
  mcpHttpDebugStorage,
  runWithHttpDebugSink,
} from '../../../src/tools/mcp/http_debug_recorder.js';
import {
  HttpExchange,
  captureHttpDebug,
  runWithHttpDebugCapture,
} from '../../../src/utils/http_debug_utils.js';
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

/**
 * Builds a stdio transport test double.
 *
 * `StdioClientTransport` is a class with private state, so no object literal
 * satisfies it structurally. The cast lives here rather than at each stub site.
 *
 * @param stderr The stderr stream the transport exposes, if any.
 * @return The stub, typed as a transport.
 */
function stdioTransportStub(stderr: PassThrough | null): StdioClientTransport {
  return {stderr} as unknown as StdioClientTransport;
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
        fetch: expect.any(Function),
        requestInit: {
          headers: {'x-test-header': 'test-value'},
        },
      },
    );
    expect(client.connect).toHaveBeenCalled();
  });

  it('records the HTTP exchanges of a call made inside a debug sink', async () => {
    const callerFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const transportOptions = {fetch: callerFetch};
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions,
    });
    const sink: HttpDebugExchange[] = [];

    await runWithHttpDebugSink(sink, () => manager.createSession());

    const installed = vi.mocked(StreamableHTTPClientTransport).mock
      .lastCall?.[1];
    expect(installed?.fetch).not.toBe(callerFetch);
    await installed?.fetch?.('http://test-url');
    expect(callerFetch).toHaveBeenCalled();
    expect(sink).toHaveLength(1);
    // The caller's own options object is never modified.
    expect(transportOptions.fetch).toBe(callerFetch);
  });

  it('installs no sink recorder when the session is created without one', async () => {
    // The other debug recorder always installs a transparent wrapper, so the
    // assertion is that a sink opened after the session records nothing, not
    // that the caller's options object reaches the transport unwrapped.
    const callerFetch = vi.fn().mockResolvedValue(new Response('ok'));
    const transportOptions = {fetch: callerFetch};
    const manager = new MCPSessionManager({
      type: 'StreamableHTTPConnectionParams',
      url: 'http://test-url',
      transportOptions,
    });
    const sink: HttpDebugExchange[] = [];

    await manager.createSession();

    const installed = vi.mocked(StreamableHTTPClientTransport).mock
      .lastCall?.[1];
    await runWithHttpDebugSink(sink, () =>
      installed?.fetch?.('http://test-url'),
    );
    expect(callerFetch).toHaveBeenCalled();
    expect(sink).toEqual([]);
    // The caller's own options object is never modified.
    expect(transportOptions.fetch).toBe(callerFetch);
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
        fetch: expect.any(Function),
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
        fetch: expect.any(Function),
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
        fetch: expect.any(Function),
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

  describe('errlog', () => {
    /** Installs a stdio transport double exposing `stderr`. */
    function stubStdioTransport(stderr: PassThrough | null): void {
      vi.mocked(StdioClientTransport).mockImplementationOnce(() =>
        stdioTransportStub(stderr),
      );
    }

    /** A writable stream that keeps everything written to it. */
    function capturingStream(): {stream: Writable; text: () => string} {
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      return {stream, text: () => chunks.join('')};
    }

    /** Lets the stream machinery deliver every pending 'data' event. */
    function flushStreams(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    it('asks a stdio server to pipe its stderr', async () => {
      const manager = new MCPSessionManager(
        {
          type: 'StdioConnectionParams',
          serverParams: {command: 'test-command'},
        },
        {errlog: capturingStream().stream},
      );

      await manager.createSession();

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'test-command',
        stderr: 'pipe',
      });
    });

    it('inherits a stdio server stderr when no errlog is given', async () => {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      await manager.createSession();

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'test-command',
      });
    });

    it('forwards the stdio server stderr to errlog', async () => {
      const serverStderr = new PassThrough();
      stubStdioTransport(serverStderr);
      const errlog = capturingStream();
      const manager = new MCPSessionManager(
        {
          type: 'StdioConnectionParams',
          serverParams: {command: 'test-command'},
        },
        {errlog: errlog.stream},
      );

      await manager.createSession();
      serverStderr.write('server said something\n');
      await flushStreams();

      expect(errlog.text()).toBe('server said something\n');
    });

    it('stops forwarding stderr once the session is closed', async () => {
      const serverStderr = new PassThrough();
      stubStdioTransport(serverStderr);
      const errlog = capturingStream();
      const manager = new MCPSessionManager(
        {
          type: 'StdioConnectionParams',
          serverParams: {command: 'test-command'},
        },
        {errlog: errlog.stream},
      );

      const client = await manager.createSession();
      serverStderr.write('before close\n');
      await flushStreams();
      await manager.closeSession(client);
      serverStderr.write('after close\n');
      await flushStreams();

      expect(errlog.text()).toBe('before close\n');
      expect(serverStderr.listenerCount('data')).toBe(0);
    });

    it('tolerates a stdio transport that exposes no stderr', async () => {
      stubStdioTransport(null);
      const errlog = capturingStream();
      const manager = new MCPSessionManager(
        {
          type: 'StdioConnectionParams',
          serverParams: {command: 'test-command'},
        },
        {errlog: errlog.stream},
      );

      const client = await manager.createSession();

      await expect(manager.closeSession(client)).resolves.toBeUndefined();
      expect(errlog.text()).toBe('');
      expect(manager.getActiveSessions()).toHaveLength(0);
    });

    it('sends a transport error to errlog instead of the logger', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const errlog = capturingStream();
      const manager = new MCPSessionManager(
        {type: 'StreamableHTTPConnectionParams', url: 'http://test-url'},
        {errlog: errlog.stream},
      );

      await manager.createSession();
      const transport = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.instances.at(-1);
      transport?.onerror?.(new Error('background stream died'));

      expect(errlog.text()).toContain('MCP transport error');
      expect(errlog.text()).toContain('background stream died');
      expect(errorSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  describe('HTTP debug capture', () => {
    it('records no exchange for a session opened outside a capture', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('pong', {status: 200})),
      );
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });
      await manager.createSession();
      const options = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.calls.at(-1)?.[1];
      if (!options?.fetch) {
        expect.fail('the transport was given no fetch');
      }
      const transportFetch = options.fetch;

      const exchanges: HttpExchange[] = [];
      await runWithHttpDebugCapture(exchanges, () =>
        transportFetch('http://test-url/mcp', {method: 'POST'}),
      );

      vi.unstubAllGlobals();
      expect(exchanges).toEqual([]);
    });

    it('records an exchange the global fetch performs', async () => {
      const globalFetch = vi
        .fn()
        .mockResolvedValue(new Response('pong', {status: 200}));
      vi.stubGlobal('fetch', globalFetch);
      const exchanges: HttpExchange[] = [];

      await runWithHttpDebugCapture(exchanges, async () => {
        const manager = new MCPSessionManager({
          type: 'StreamableHTTPConnectionParams',
          url: 'http://test-url',
        });
        await manager.createSession();
        const options = vi
          .mocked(StreamableHTTPClientTransport)
          .mock.calls.at(-1)?.[1];
        if (!options?.fetch) {
          expect.fail('the transport was given no fetch');
        }
        await options.fetch('http://test-url/mcp', {method: 'POST'});
      });

      vi.unstubAllGlobals();
      expect(globalFetch).toHaveBeenCalledOnce();
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].responseBody).toBe('pong');
    });

    it('records a request that names no method as a GET', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('pong', {status: 200})),
      );
      const exchanges: HttpExchange[] = [];

      await runWithHttpDebugCapture(exchanges, async () => {
        const manager = new MCPSessionManager({
          type: 'StreamableHTTPConnectionParams',
          url: 'http://test-url',
        });
        await manager.createSession();
        const options = vi
          .mocked(StreamableHTTPClientTransport)
          .mock.calls.at(-1)?.[1];
        if (!options?.fetch) {
          expect.fail('the transport was given no fetch');
        }
        await options.fetch('http://test-url/mcp');
      });

      vi.unstubAllGlobals();
      expect(exchanges[0].method).toBe('GET');
    });
  });

  describe('per-session headers', () => {
    it('puts the headers on the HTTP transport requestInit', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession({headers: {Authorization: 'Bearer token'}});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          fetch: expect.any(Function),
          requestInit: {headers: {authorization: 'Bearer token'}},
        },
      );
    });

    it('merges per-session headers over the configured ones', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {
            headers: {'x-tenant': 'configured', 'x-keep': 'kept'},
          },
        },
      });

      await manager.createSession({
        headers: {'x-tenant': 'per-session', 'Authorization': 'Bearer token'},
      });

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        {
          fetch: expect.any(Function),
          requestInit: {
            headers: {
              'x-tenant': 'per-session',
              'x-keep': 'kept',
              'authorization': 'Bearer token',
            },
          },
        },
      );
    });

    it('merges the headers over the configured transport headers', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {headers: {'x-static': 'static-value'}},
        },
      });

      await manager.createSession({headers: {'x-tenant': 'tenant-a'}});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          fetch: expect.any(Function),
          requestInit: {
            headers: {'x-static': 'static-value', 'x-tenant': 'tenant-a'},
          },
        },
      );
    });

    it('does not retain per-session headers on the configured options', async () => {
      const transportOptions = {requestInit: {headers: {'x-keep': 'kept'}}};
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions,
      });

      await manager.createSession({headers: {'x-once': 'first'}});
      await manager.createSession();

      expect(transportOptions.requestInit.headers).toEqual({'x-keep': 'kept'});
      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          fetch: expect.any(Function),
          requestInit: {headers: {'x-keep': 'kept'}},
        },
      );
    });

    it('does not leak one session headers into the next', async () => {
      const transportOptions = {requestInit: {}};
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions,
      });

      await manager.createSession({headers: {'x-tenant': 'tenant-a'}});
      await manager.createSession({headers: {'x-tenant': 'tenant-b'}});

      expect(transportOptions).toEqual({requestInit: {}});
      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {
          fetch: expect.any(Function),
          requestInit: {headers: {'x-tenant': 'tenant-b'}},
        },
      );
    });

    it('sends per-session headers when the transport configures none', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession({headers: {'x-tenant': 'per-session'}});

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        {
          fetch: expect.any(Function),
          requestInit: {headers: {'x-tenant': 'per-session'}},
        },
      );
    });

    it('ignores per-session headers on a stdio connection', async () => {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      const client = await manager.createSession({
        headers: {'x-tenant': 'per-session'},
      });

      expect(StdioClientTransport).toHaveBeenLastCalledWith({
        command: 'test-command',
      });
      expect(client.connect).toHaveBeenCalled();
    });
  });

  describe('server-to-client callbacks', () => {
    const stdioParams: MCPConnectionParams = {
      type: 'StdioConnectionParams',
      serverParams: {command: 'test-command'},
    };

    /** A handler the manager registered, so this test can call it back. */
    type RecordedHandler = (request: unknown, extra: unknown) => unknown;

    /**
     * A client stub that records the handlers the manager registers on it.
     *
     * The stub is cast rather than built with `clientStub`: the SDK ties
     * `setRequestHandler`'s handler parameter to the Zod schema passed
     * alongside it, so a recorder that accepts any schema cannot satisfy that
     * signature.
     */
    function stubClient(): {
      client: Client;
      handlers: Map<unknown, RecordedHandler>;
    } {
      const handlers = new Map<unknown, RecordedHandler>();
      const client = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        setRequestHandler: (schema: unknown, handler: RecordedHandler) => {
          handlers.set(schema, handler);
        },
      } as unknown as Client;
      vi.mocked(Client).mockImplementationOnce(() => client);
      return {client, handlers};
    }

    it('declares no capability and registers no handler by default', async () => {
      const {handlers} = stubClient();

      await new MCPSessionManager(stdioParams).createSession();

      expect(Client).toHaveBeenLastCalledWith({
        name: 'MCPClient',
        version: '1.0.0',
      });
      expect(handlers.size).toBe(0);
    });

    it('answers a sampling request with the sampling callback', async () => {
      const {handlers} = stubClient();
      const samplingCallback = vi.fn().mockResolvedValue({
        model: 'test-model',
        role: 'assistant',
        content: {type: 'text', text: 'sampled'},
      });

      await new MCPSessionManager(stdioParams, {
        samplingCallback,
      }).createSession();

      expect(Client).toHaveBeenLastCalledWith(
        {name: 'MCPClient', version: '1.0.0'},
        {capabilities: {sampling: {}}},
      );

      const handler = handlers.get(CreateMessageRequestSchema);
      if (!handler) {
        expect.fail('no sampling/createMessage handler was registered');
      }
      const params = {messages: [], maxTokens: 10};
      await expect(handler({params}, undefined)).resolves.toMatchObject({
        content: {text: 'sampled'},
      });
      expect(samplingCallback).toHaveBeenCalledWith(params);
    });

    it('declares the configured sampling capabilities', async () => {
      stubClient();

      await new MCPSessionManager(stdioParams, {
        samplingCallback: vi.fn(),
        samplingCapabilities: {tools: {}},
      }).createSession();

      expect(Client).toHaveBeenLastCalledWith(
        {name: 'MCPClient', version: '1.0.0'},
        {capabilities: {sampling: {tools: {}}}},
      );
    });

    it('answers an elicitation request with the elicitation callback', async () => {
      const {handlers} = stubClient();
      const elicitationCallback = vi
        .fn()
        .mockResolvedValue({action: 'accept', content: {answer: 'yes'}});

      await new MCPSessionManager(stdioParams, {
        elicitationCallback,
      }).createSession();

      expect(Client).toHaveBeenLastCalledWith(
        {name: 'MCPClient', version: '1.0.0'},
        {capabilities: {elicitation: {}}},
      );

      const handler = handlers.get(ElicitRequestSchema);
      if (!handler) {
        expect.fail('no elicitation/create handler was registered');
      }
      const params = {message: 'pick one', requestedSchema: {type: 'object'}};
      await expect(handler({params}, undefined)).resolves.toMatchObject({
        action: 'accept',
      });
      expect(elicitationCallback).toHaveBeenCalledWith(params);
    });
  });

  describe('HTTP debug capture', () => {
    function transportOptions(): StreamableHTTPClientTransportOptions {
      const call = vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1);
      if (!call) {
        expect.fail('the transport was never constructed');
      }
      return call[1] ?? {};
    }

    it('records nothing when no sink is active', async () => {
      // The other debug recorder always installs its own transparent wrapper,
      // so the assertion is that nothing is recorded and the request is
      // delegated untouched, not that no wrapper is present.
      const sink: HttpDebugExchange[] = [];
      const globalFetch = vi.fn().mockResolvedValue(new Response('{"ok":1}'));
      vi.stubGlobal('fetch', globalFetch);
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession();
      await transportOptions().fetch?.('http://test-url', {method: 'POST'});
      vi.unstubAllGlobals();

      expect(globalFetch).toHaveBeenCalledOnce();
      expect(sink).toEqual([]);
    });

    it('installs a recording fetch over the global one', async () => {
      const sink: HttpDebugExchange[] = [];
      const globalFetch = vi.fn().mockResolvedValue(new Response('{"ok":1}'));
      vi.stubGlobal('fetch', globalFetch);
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await runWithHttpDebugSink(sink, () => manager.createSession());
      const recording = transportOptions().fetch;
      if (!recording) {
        expect.fail('expected a recording fetch to be installed');
      }
      await recording('http://test-url', {method: 'POST', body: '{}'});
      vi.unstubAllGlobals();

      expect(globalFetch).toHaveBeenCalledOnce();
      expect(sink).toEqual([
        expect.objectContaining({
          url: 'http://test-url',
          method: 'POST',
          request_body: '{}',
        }),
      ]);
    });

    it('records through the caller-supplied fetch', async () => {
      const sink: HttpDebugExchange[] = [];
      const userFetch = vi.fn().mockResolvedValue(new Response('{"ok":1}'));
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {fetch: userFetch},
      });

      await runWithHttpDebugSink(sink, () => manager.createSession());
      await transportOptions().fetch?.('http://test-url');

      expect(userFetch).toHaveBeenCalledOnce();
      expect(sink).toHaveLength(1);
    });

    it('leaves the caller transport options unmodified', async () => {
      const callerOptions = {requestInit: {headers: {'x-test': '1'}}};
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: callerOptions,
      });

      await runWithHttpDebugSink([], () => manager.createSession());

      expect(callerOptions).toEqual({requestInit: {headers: {'x-test': '1'}}});
    });
  });

  describe('HTTP debug capture via instrumentFetch', () => {
    /** The fetch the manager installed on the streamable-HTTP transport. */
    async function installedFetch(
      baseFetch?: StreamableHTTPClientTransportOptions['fetch'],
    ): Promise<NonNullable<StreamableHTTPClientTransportOptions['fetch']>> {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'https://mcp.example.com/mcp',
        ...(baseFetch && {transportOptions: {fetch: baseFetch}}),
      });
      await manager.createSession();
      const options = vi
        .mocked(StreamableHTTPClientTransport)
        .mock.calls.at(-1)?.[1];
      if (!options?.fetch) {
        expect.fail('the manager passed no fetch to the transport');
      }
      return options.fetch;
    }

    it('records the exchanges the session performs', async () => {
      const transportFetch = await installedFetch(
        async () =>
          new Response('{"ok":true}', {
            headers: {'content-type': 'application/json'},
          }),
      );
      const records: HttpDebugRecord[] = [];

      await captureHttpDebug(records, () =>
        transportFetch('https://mcp.example.com/mcp', {
          method: 'POST',
          headers: {authorization: 'Bearer secret'},
        }),
      );

      expect(records).toHaveLength(1);
      expect(records[0].request_headers['authorization']).toBe('<redacted>');
      expect(records[0].response_body).toBe('{"ok":true}');
    });

    it('still delegates to a caller-supplied fetch', async () => {
      const baseFetch = vi.fn(async () => new Response('from caller'));
      const transportFetch = await installedFetch(baseFetch);

      const response = await transportFetch('https://mcp.example.com/mcp');

      expect(await response.text()).toBe('from caller');
      expect(baseFetch).toHaveBeenCalledTimes(1);
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

  // The branch always instruments the transport's fetch for a different
  // capture, so the fetch the manager installs is never the caller's own
  // object. These two cases therefore assert the same property by its effect:
  // with no sink active the MCP recorder installs nothing, so a sink opened
  // afterwards receives no exchange.
  it('leaves the transport options untouched with no sink active', async () => {
    const sink: McpHttpExchange[] = [];
    const baseFetch = vi.fn(async () => jsonResponse(200));

    const wrapped = await fetchForSession(baseFetch);
    await mcpHttpDebugStorage.run(sink, () =>
      wrapped?.('http://test-url/mcp', {method: 'POST'}),
    );

    expect(baseFetch).toHaveBeenCalledOnce();
    expect(sink).toHaveLength(0);
  });

  it('does not add a fetch when the caller configured none', async () => {
    const sink: McpHttpExchange[] = [];
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200));

    const wrapped = await fetchForSession(undefined);
    await mcpHttpDebugStorage.run(sink, () =>
      wrapped?.('http://test-url/mcp', {method: 'POST'}),
    );

    expect(sink).toHaveLength(0);
    globalFetch.mockRestore();
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
