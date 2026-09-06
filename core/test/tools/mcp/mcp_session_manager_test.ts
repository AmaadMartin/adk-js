/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPConnectionParams, MCPSessionManager} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  // Cleared for every test, so an assertion only ever sees the transport its
  // own test constructed and the file stays order-independent.
  beforeEach(() => {
    vi.mocked(StreamableHTTPClientTransport).mockClear();
    vi.mocked(StdioClientTransport).mockClear();
  });

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
  describe('createSession headers', () => {
    /** Options handed to the most recently constructed HTTP transport. */
    const lastTransportOptions = () =>
      vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1)?.[1];

    /**
     * The headers of those options, as a record. `Headers` lower-cases every
     * name it stores, which is the spelling that reaches the wire.
     */
    const lastHeaders = () => {
      const record: Record<string, string> = {};
      new Headers(lastTransportOptions()?.requestInit?.headers).forEach(
        (value, name) => {
          record[name] = value;
        },
      );
      return record;
    };

    it('merges extraHeaders into transportOptions.requestInit.headers', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {'x-static': 'yes'}}},
      });

      await manager.createSession(new Headers({Authorization: 'Bearer t'}));

      expect(lastHeaders()).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer t',
      });
    });

    it('adds extraHeaders when the connection carries no static headers', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession(new Headers({Authorization: 'Bearer t'}));

      expect(lastHeaders()).toEqual({authorization: 'Bearer t'});
    });

    it('extraHeaders win over static transportOptions headers on conflict', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {headers: {Authorization: 'Bearer old'}},
        },
      });

      await manager.createSession(new Headers({Authorization: 'Bearer new'}));

      expect(lastHeaders()).toEqual({authorization: 'Bearer new'});
    });

    it('merges extraHeaders over the deprecated header field', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        header: {'x-legacy': 'yes', Authorization: 'Bearer old'},
      });

      await manager.createSession(new Headers({Authorization: 'Bearer new'}));

      expect(lastHeaders()).toEqual({
        'x-legacy': 'yes',
        authorization: 'Bearer new',
      });
    });

    it('stringifies a non-string value in the deprecated header field', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        // The field is typed `Record<string, unknown>`, so a caller can put a
        // number here and the transport only accepts strings.
        header: {'x-count': 42},
      });

      await manager.createSession(new Headers({authorization: 'Bearer t'}));

      expect(lastHeaders()).toEqual({
        'x-count': '42',
        authorization: 'Bearer t',
      });
    });

    it('stringifies a non-string deprecated header with no extra headers', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        header: {'x-count': 42},
      });

      await manager.createSession();

      // Read the raw options rather than `lastHeaders()`: with no extra
      // headers nothing constructs a `Headers`, so this is the only test that
      // sees what the deprecated field alone hands the transport.
      expect(lastTransportOptions()?.requestInit?.headers).toEqual({
        'x-count': '42',
      });
    });

    it('preserves static headers supplied as a Headers instance', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {headers: new Headers({'x-static': 'yes'})},
        },
      });

      await manager.createSession(new Headers({Authorization: 'Bearer t'}));

      expect(lastHeaders()).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer t',
      });
    });

    it('preserves static headers supplied as an array of pairs', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: [['x-static', 'yes']]}},
      });

      await manager.createSession(new Headers({Authorization: 'Bearer t'}));

      expect(lastHeaders()).toEqual({
        'x-static': 'yes',
        authorization: 'Bearer t',
      });
    });

    it('keeps the static headers for an empty extraHeaders record', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {'x-static': 'yes'}}},
      });

      await manager.createSession(new Headers({}));

      expect(lastHeaders()).toEqual({'x-static': 'yes'});
    });

    it('sends no header for an empty extraHeaders record', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession(new Headers({}));

      expect(lastHeaders()).toEqual({});
    });

    it('does not mutate the callers connectionParams', async () => {
      // `transportOptions` must be present but carry no `requestInit`: that is
      // the only shape where the deprecated `header` fallback used to write
      // back into the object the caller still owns.
      const params: MCPConnectionParams = {
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {},
        header: {'x-legacy': 'yes'},
      };
      const snapshot = structuredClone(params);

      const manager = new MCPSessionManager(params);
      await manager.createSession(new Headers({Authorization: 'Bearer t'}));

      expect(params).toEqual(snapshot);
      expect(lastHeaders()).toEqual({
        'x-legacy': 'yes',
        authorization: 'Bearer t',
      });
    });

    it('does not bleed headers between successive sessions', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {'x-static': 'yes'}}},
      });

      await manager.createSession(new Headers({'x-first': '1'}));
      await manager.createSession(new Headers({'x-second': '2'}));

      expect(lastHeaders()).toEqual({'x-static': 'yes', 'x-second': '2'});
    });

    it('replaces a static header that differs only in case', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {authorization: 'old'}}},
      });

      await manager.createSession(new Headers({Authorization: 'new'}));

      expect(lastHeaders()).toEqual({authorization: 'new'});
    });

    it('ignores extraHeaders for stdio connections', async () => {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      const client = await manager.createSession(
        new Headers({Authorization: 'Bearer t'}),
      );

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'test-command',
      });
      expect(client.connect).toHaveBeenCalled();
    });
  });
});
