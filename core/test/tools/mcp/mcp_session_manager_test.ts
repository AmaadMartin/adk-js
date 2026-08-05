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

  describe('createSession headers', () => {
    /** Options handed to the most recently constructed HTTP transport. */
    const lastTransportOptions = () =>
      vi.mocked(StreamableHTTPClientTransport).mock.calls.at(-1)?.[1];

    beforeEach(() => {
      vi.mocked(StreamableHTTPClientTransport).mockClear();
      vi.mocked(StdioClientTransport).mockClear();
    });

    it('merges extraHeaders into transportOptions.requestInit.headers', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {'x-static': 'yes'}}},
      });

      await manager.createSession({Authorization: 'Bearer t'});

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'x-static': 'yes', Authorization: 'Bearer t'}},
      });
    });

    it('adds extraHeaders when the connection carries no static headers', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession({Authorization: 'Bearer t'});

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {Authorization: 'Bearer t'}},
      });
    });

    it('extraHeaders win over static transportOptions headers on conflict', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {
          requestInit: {headers: {Authorization: 'Bearer old'}},
        },
      });

      await manager.createSession({Authorization: 'Bearer new'});

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {Authorization: 'Bearer new'}},
      });
    });

    it('merges extraHeaders over the deprecated header field', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        header: {'x-legacy': 'yes', Authorization: 'Bearer old'},
      });

      await manager.createSession({Authorization: 'Bearer new'});

      expect(lastTransportOptions()).toEqual({
        requestInit: {
          headers: {'x-legacy': 'yes', Authorization: 'Bearer new'},
        },
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

      await manager.createSession({Authorization: 'Bearer t'});

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'x-static': 'yes', Authorization: 'Bearer t'}},
      });
    });

    it('preserves static headers supplied as an array of pairs', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: [['x-static', 'yes']]}},
      });

      await manager.createSession({Authorization: 'Bearer t'});

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'x-static': 'yes', Authorization: 'Bearer t'}},
      });
    });

    it('leaves transport options untouched for an empty extraHeaders record', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {'x-static': 'yes'}}},
      });

      await manager.createSession({});

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'x-static': 'yes'}},
      });
    });

    it('adds no requestInit at all for an empty extraHeaders record', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
      });

      await manager.createSession({});

      expect(lastTransportOptions()).toEqual({});
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
      await manager.createSession({Authorization: 'Bearer t'});

      expect(params).toEqual(snapshot);
      expect(lastTransportOptions()).toEqual({
        requestInit: {
          headers: {'x-legacy': 'yes', Authorization: 'Bearer t'},
        },
      });
    });

    it('does not bleed headers between successive sessions', async () => {
      const manager = new MCPSessionManager({
        type: 'StreamableHTTPConnectionParams',
        url: 'http://test-url',
        transportOptions: {requestInit: {headers: {'x-static': 'yes'}}},
      });

      await manager.createSession({'x-first': '1'});
      await manager.createSession({'x-second': '2'});

      expect(lastTransportOptions()).toEqual({
        requestInit: {headers: {'x-static': 'yes', 'x-second': '2'}},
      });
    });

    it('ignores extraHeaders for stdio connections', async () => {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test-command'},
      });

      const client = await manager.createSession({Authorization: 'Bearer t'});

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'test-command',
      });
      expect(client.connect).toHaveBeenCalled();
    });
  });
});
