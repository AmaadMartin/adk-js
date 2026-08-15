/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  MCPSessionManager,
  MCPTool,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {RequestOptions} from '@modelcontextprotocol/sdk/shared/protocol.js';
import {ErrorCode, McpError, Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, vi} from 'vitest';

/**
 * Stands in for `MCPSessionManager.withTimeout` on the duck-typed session
 * manager mocks below, which carry no connection parameters of their own.
 */
function withTimeout<T>(
  _operation: string,
  call: (options: RequestOptions) => Promise<T>,
): Promise<T> {
  return call({});
}

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
      withTimeout,
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
      withTimeout,
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
      withTimeout,
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
      withTimeout,
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
  describe('round-trip deadline', () => {
    const TIMEOUT_MS = 5000;

    const mcpTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    /** A real session manager whose sessions are the supplied client. */
    function managerFor(client: Client): MCPSessionManager {
      const manager = new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'test'},
        timeout: TIMEOUT_MS,
      });
      vi.spyOn(manager, 'createSession').mockResolvedValue(client);
      return manager;
    }

    /** A tool context carrying `signal` as its abort signal. */
    function contextFor(signal: AbortSignal): Context {
      const invocationContext = {
        abortSignal: signal,
        session: {state: {}},
      } as unknown as InvocationContext;
      return new Context({invocationContext});
    }

    it('sends the deadline alongside the abort signal', async () => {
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({content: []}),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Client;
      const signal = new AbortController().signal;
      const tool = new MCPTool(mcpTool, managerFor(mockClient));

      await tool.runAsync({args: {}, toolContext: contextFor(signal)});

      expect(mockClient.callTool).toHaveBeenCalledWith(
        {name: 'test-tool', arguments: {}},
        undefined,
        {signal, timeout: TIMEOUT_MS},
      );
    });

    it('names callTool and the deadline when the server is too slow', async () => {
      const mockClient = {
        callTool: vi
          .fn()
          .mockRejectedValue(
            new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
          ),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Client;
      const tool = new MCPTool(mcpTool, managerFor(mockClient));

      await expect(
        tool.runAsync({
          args: {},
          toolContext: contextFor(new AbortController().signal),
        }),
      ).rejects.toThrow('MCP callTool timed out after 5000ms');
    });
  });
});
