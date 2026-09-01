/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPConnectionParams, MCPSessionManager} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {StreamableHTTPClientTransportOptions} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {PassThrough, Writable} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import {
  HttpDebugExchange,
  runWithHttpDebugSink,
} from '../../../src/tools/mcp/http_debug_recorder.js';
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

  describe('errlog', () => {
    /**
     * Installs a stdio transport exposing `stderr`. The one cast lives here:
     * the SDK module is `vi.mock`ed, so the stub carries only the property
     * the manager reads, which cannot satisfy the full transport type.
     */
    function stubStdioTransport(stderr: PassThrough | null): void {
      vi.mocked(StdioClientTransport).mockImplementationOnce(
        () => ({stderr}) as unknown as StdioClientTransport,
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
      await manager.closeSession(client);

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

  describe('per-session headers', () => {
    it('puts the headers on the HTTP transport requestInit', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession({headers: {Authorization: 'Bearer token'}});

      expect(StreamableHTTPClientTransport).toHaveBeenLastCalledWith(
        expect.any(URL),
        {requestInit: {headers: {authorization: 'Bearer token'}}},
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
        {requestInit: {headers: {'x-keep': 'kept'}}},
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
        {requestInit: {headers: {'x-tenant': 'tenant-b'}}},
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
        {requestInit: {headers: {'x-tenant': 'per-session'}}},
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

    it('installs no fetch wrapper when no sink is active', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession();

      expect(transportOptions().fetch).toBeUndefined();
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
});
