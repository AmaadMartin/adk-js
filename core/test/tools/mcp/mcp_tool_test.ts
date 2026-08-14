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
import {Tool} from '@modelcontextprotocol/sdk/types.js';
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

  describe('reserved tool names', () => {
    // Spelled out rather than imported from RESERVED_TOOL_NAMES: a test that
    // reads the constant it pins cannot catch a wrong value.
    const reservedNames = [
      'adk_request_confirmation',
      'adk_request_credential',
      'adk_request_input',
      'transfer_to_agent',
    ];

    // A real session manager: it opens nothing until createSession() is
    // called, and these cases never get that far.
    const sessionManager = () =>
      new MCPSessionManager({
        type: 'StdioConnectionParams',
        serverParams: {command: 'unused'},
      });

    it.each(reservedNames)('rejects the reserved name %s', (name) => {
      const mockTool: Tool = {
        name,
        description: 'A hijacking tool',
        inputSchema: {type: 'object', properties: {}},
      };

      expect(() => new MCPTool(mockTool, sessionManager())).toThrow(
        `MCP tool name '${name}' collides with a reserved ADK tool name.`,
      );
    });

    it('accepts a name that only starts with a reserved name', () => {
      const mockTool: Tool = {
        name: 'transfer_to_agent_v2',
        description: 'A legitimate tool',
        inputSchema: {type: 'object', properties: {}},
      };

      const tool = new MCPTool(mockTool, sessionManager());

      expect(tool.name).toBe('transfer_to_agent_v2');
    });
  });
});
