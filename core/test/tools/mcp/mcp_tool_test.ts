/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  MCPConnectionParams,
  MCPProgressCallbackFactory,
  MCPProgressCallbackFactoryRequest,
  MCPSessionManager,
  MCPTool,
  PluginManager,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {ProgressCallback} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {Progress, Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, vi} from 'vitest';

describe('MCPTool', () => {
  it('passes abort signal to callTool', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const controller = new AbortController();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: signal},
    );
  });

  it('uses originalName for callTool when provided', async () => {
    const mockTool: Tool = {
      name: 'prefixed_test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager, 'test-tool');

    const controller = new AbortController();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: signal},
    );
  });

  it('respects abort signal when callTool rejects', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockImplementation((_params, _extra, options) => {
        if (options?.signal?.aborted) {
          return Promise.reject(new Error('Aborted'));
        }
        return Promise.resolve({content: []});
      }),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Aborted',
    );
  });

  it('closes session even when callTool throws an error', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockRejectedValue(new Error('Call failed')),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const invocationContext = {
      abortSignal: new AbortController().signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );

    // Assert that closeSession was still called despite the error
    expect(mockSessionManager.closeSession).toHaveBeenCalledWith(mockClient);
  });

  describe('progress notifications', () => {
    const progressTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const stdioParams: MCPConnectionParams = {
      type: 'StdioConnectionParams',
      serverParams: {command: 'never-spawned'},
    };

    /** A tool context backed by a real session, so state writes are visible. */
    function createToolContext(): Context {
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
        }),
        pluginManager: new PluginManager([]),
        abortSignal: new AbortController().signal,
      });
      return new Context({invocationContext});
    }

    /** A session manager that hands out `client` and never closes it. */
    function createSessionManager(client: Client): MCPSessionManager {
      const sessionManager = new MCPSessionManager(stdioParams);
      vi.spyOn(sessionManager, 'createSession').mockResolvedValue(client);
      vi.spyOn(sessionManager, 'closeSession').mockResolvedValue(undefined);
      return sessionManager;
    }

    function createClient(): Client {
      return new Client({name: 'test-client', version: '1.0.0'});
    }

    it('forwards a configured progress callback to callTool', async () => {
      const client = createClient();
      const callTool = vi
        .spyOn(client, 'callTool')
        .mockResolvedValue({content: []});
      const progressCallback: ProgressCallback = () => {};
      const tool = new MCPTool(
        progressTool,
        createSessionManager(client),
        undefined,
        {progressCallback},
      );
      const toolContext = createToolContext();

      await tool.runAsync({args: {}, toolContext});

      expect(callTool).toHaveBeenCalledWith(
        {name: 'test-tool', arguments: {}},
        undefined,
        {signal: toolContext.abortSignal, onprogress: progressCallback},
      );
    });

    it('delivers every progress notification to the callback', async () => {
      const client = createClient();
      vi.spyOn(client, 'callTool').mockImplementation(
        async (_params, _schema, options) => {
          options?.onprogress?.({progress: 0.37, total: 1, message: 'working'});
          options?.onprogress?.({progress: 1, total: 1});
          return {content: []};
        },
      );
      const received: Progress[] = [];
      const tool = new MCPTool(
        progressTool,
        createSessionManager(client),
        undefined,
        {progressCallback: (progress) => received.push(progress)},
      );

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(received).toEqual([
        {progress: 0.37, total: 1, message: 'working'},
        {progress: 1, total: 1},
      ]);
    });

    it('builds the callback from the factory on every invocation', async () => {
      const client = createClient();
      const callTool = vi
        .spyOn(client, 'callTool')
        .mockResolvedValue({content: []});
      const callback: ProgressCallback = () => {};
      const factory = vi.fn(
        (_request: MCPProgressCallbackFactoryRequest): ProgressCallback =>
          callback,
      );
      const prefixedTool: Tool = {...progressTool, name: 'pfx_test-tool'};
      const tool = new MCPTool(
        prefixedTool,
        createSessionManager(client),
        'test-tool',
        {progressCallbackFactory: factory},
      );
      const toolContext = createToolContext();

      await tool.runAsync({args: {}, toolContext});
      await tool.runAsync({args: {}, toolContext});

      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory.mock.calls[0][0].toolName).toBe('pfx_test-tool');
      expect(factory.mock.calls[0][0].callbackContext).toBe(toolContext);
      expect(callTool).toHaveBeenLastCalledWith(
        {name: 'test-tool', arguments: {}},
        undefined,
        {signal: toolContext.abortSignal, onprogress: callback},
      );
    });

    it('omits onprogress when the factory returns undefined', async () => {
      const client = createClient();
      const callTool = vi
        .spyOn(client, 'callTool')
        .mockResolvedValue({content: []});
      const factory: MCPProgressCallbackFactory = () => undefined;
      const tool = new MCPTool(
        progressTool,
        createSessionManager(client),
        undefined,
        {progressCallbackFactory: factory},
      );

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(Object.keys(callTool.mock.calls[0][2] ?? {})).toEqual(['signal']);
    });

    it('omits onprogress when no options are supplied', async () => {
      const client = createClient();
      const callTool = vi
        .spyOn(client, 'callTool')
        .mockResolvedValue({content: []});
      const tool = new MCPTool(progressTool, createSessionManager(client));

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(Object.keys(callTool.mock.calls[0][2] ?? {})).toEqual(['signal']);
    });

    it('lets a factory callback write session state', async () => {
      const client = createClient();
      vi.spyOn(client, 'callTool').mockImplementation(
        async (_params, _schema, options) => {
          options?.onprogress?.({progress: 0.5, total: 1});
          return {content: []};
        },
      );
      const tool = new MCPTool(
        progressTool,
        createSessionManager(client),
        undefined,
        {
          progressCallbackFactory:
            ({callbackContext}) =>
            (progress) => {
              callbackContext.state.set('lastProgress', progress.progress);
            },
        },
      );
      const toolContext = createToolContext();

      await tool.runAsync({args: {}, toolContext});

      expect(toolContext.state.get('lastProgress')).toBe(0.5);
    });

    it('rejects a callback and a factory supplied together', () => {
      const progressCallback: ProgressCallback = () => {};
      const progressCallbackFactory: MCPProgressCallbackFactory = () =>
        undefined;

      expect(
        () =>
          new MCPTool(
            progressTool,
            createSessionManager(createClient()),
            undefined,
            {progressCallback, progressCallbackFactory},
          ),
      ).toThrow(
        'MCPTool accepts either progressCallback or progressCallbackFactory, not both.',
      );
    });

    it('receives progress sent by a linked MCP server', async () => {
      const server = new McpServer({name: 'test-server', version: '1.0.0'});
      server.registerTool(
        'slow-tool',
        {description: 'Reports progress while it runs'},
        async (extra) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken !== undefined) {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: {progressToken, progress: 1, total: 2, message: 'half'},
            });
          }
          return {content: [{type: 'text', text: 'done'}]};
        },
      );

      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = createClient();
      await client.connect(clientTransport);

      const received: Progress[] = [];
      const tool = new MCPTool(
        {
          name: 'slow-tool',
          description: 'Reports progress while it runs',
          inputSchema: {type: 'object', properties: {}},
        },
        createSessionManager(client),
        'slow-tool',
        {progressCallback: (progress) => received.push(progress)},
      );

      try {
        const result = await tool.runAsync({
          args: {},
          toolContext: createToolContext(),
        });

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          progress: 1,
          total: 2,
          message: 'half',
        });
        expect(result).toMatchObject({
          content: [{type: 'text', text: 'done'}],
        });
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
