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

  describe('positional constructor', () => {
    it('exposes the declaration built from the MCP schema', () => {
      const mcpTool: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {type: 'object', properties: {city: {type: 'string'}}},
      };
      const tool = new MCPTool(mcpTool, {} as MCPSessionManager);

      const declaration = tool._getDeclaration();

      expect(declaration.name).toBe('test-tool');
      expect(declaration.description).toBe('A test tool');
      expect(declaration.parameters?.properties).toHaveProperty('city');
    });
  });

  describe('headerProvider', () => {
    it('mints headers per call and opens the session with them', async () => {
      const mcpTool: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {type: 'object', properties: {}},
      };
      const mockClient = {
        callTool: vi.fn().mockResolvedValue({content: []}),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Client;
      const createSession = vi.fn().mockResolvedValue(mockClient);
      const mockSessionManager = {
        createSession,
        closeSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as MCPSessionManager;

      let token = 'first';
      const tool = new MCPTool({
        mcpTool,
        mcpSessionManager: mockSessionManager,
        headerProvider: () => ({authorization: token}),
      });
      const toolContext = new Context({
        invocationContext: {
          abortSignal: new AbortController().signal,
          session: {state: {}},
        } as unknown as InvocationContext,
      });

      await tool.runAsync({args: {}, toolContext});
      token = 'second';
      await tool.runAsync({args: {}, toolContext});

      expect(createSession).toHaveBeenNthCalledWith(1, {
        authorization: 'first',
      });
      expect(createSession).toHaveBeenNthCalledWith(2, {
        authorization: 'second',
      });
    });

    it('opens the session with no headers when none is configured', async () => {
      const mcpTool: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {type: 'object', properties: {}},
      };
      const createSession = vi.fn().mockResolvedValue({
        callTool: vi.fn().mockResolvedValue({content: []}),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Client);
      const mockSessionManager = {
        createSession,
        closeSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as MCPSessionManager;

      const tool = new MCPTool(mcpTool, mockSessionManager);
      const toolContext = new Context({
        invocationContext: {
          abortSignal: new AbortController().signal,
          session: {state: {}},
        } as unknown as InvocationContext,
      });

      await tool.runAsync({args: {}, toolContext});

      expect(createSession).toHaveBeenCalledWith(undefined);
    });
  });
});
