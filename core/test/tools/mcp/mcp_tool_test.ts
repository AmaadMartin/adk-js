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
  MCPSessionManager,
  MCPTool,
  PluginManager,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, Mock, vi} from 'vitest';

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

  describe('session setup retry', () => {
    const retryTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const connectionParams: MCPConnectionParams = {
      type: 'StdioConnectionParams',
      serverParams: {command: 'never-spawned'},
    };

    /** A client exposing only the two methods MCPTool.runAsync calls. */
    function fakeClient(callTool: Mock): Client {
      return {
        callTool,
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Client;
    }

    /**
     * A real session manager whose transport calls are replaced by spies, so
     * no process is spawned and no connection is opened.
     */
    function fakeSessionManager(createSession: Mock): MCPSessionManager {
      const manager = new MCPSessionManager(connectionParams);
      vi.spyOn(manager, 'createSession').mockImplementation(createSession);
      vi.spyOn(manager, 'closeSession').mockResolvedValue(undefined);
      return manager;
    }

    /** Builds a tool context carrying `signal`. */
    function contextWith(signal: AbortSignal): Context {
      const invocationContext = new InvocationContext({
        invocationId: 'test-invocation',
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
        }),
        pluginManager: new PluginManager([]),
        abortSignal: signal,
      });
      return new Context({invocationContext});
    }

    it('retries session creation once and calls callTool exactly once', async () => {
      const callTool = vi.fn().mockResolvedValue({content: []});
      const createSession = vi
        .fn()
        .mockRejectedValueOnce(new Error('Failed to create MCP session'))
        .mockResolvedValue(fakeClient(callTool));

      const tool = new MCPTool(retryTool, fakeSessionManager(createSession));
      const toolContext = contextWith(new AbortController().signal);

      await expect(tool.runAsync({args: {}, toolContext})).resolves.toEqual({
        content: [],
      });
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(callTool).toHaveBeenCalledOnce();
    });

    it('rejects with the second error and never calls callTool when both session attempts fail', async () => {
      const callTool = vi.fn().mockResolvedValue({content: []});
      const createSession = vi
        .fn()
        .mockRejectedValueOnce(new Error('first failure'))
        .mockRejectedValue(new Error('second failure'));

      const tool = new MCPTool(retryTool, fakeSessionManager(createSession));
      const toolContext = contextWith(new AbortController().signal);

      await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
        'second failure',
      );
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(callTool).not.toHaveBeenCalled();
    });

    it('issues the tool call at most once when callTool rejects', async () => {
      const callTool = vi.fn().mockRejectedValue(new Error('Call failed'));
      const createSession = vi.fn().mockResolvedValue(fakeClient(callTool));

      const tool = new MCPTool(retryTool, fakeSessionManager(createSession));
      const toolContext = contextWith(new AbortController().signal);

      await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
        'Call failed',
      );
      expect(createSession).toHaveBeenCalledOnce();
      expect(callTool).toHaveBeenCalledOnce();
    });

    it('does not retry session creation when the invocation is already aborted', async () => {
      const createSession = vi
        .fn()
        .mockRejectedValue(new Error('connect failed'));

      const tool = new MCPTool(retryTool, fakeSessionManager(createSession));
      const controller = new AbortController();
      controller.abort();
      const toolContext = contextWith(controller.signal);

      await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
        'connect failed',
      );
      expect(createSession).toHaveBeenCalledOnce();
    });
  });
});
