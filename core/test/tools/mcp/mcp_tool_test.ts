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
import {describe, expect, it, Mock, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

/**
 * Builds a tool whose session close always rejects, with the context to run it.
 * Used by the cases that pin what happens when the close fails.
 */
function toolWithFailingClose(callTool: Mock): {
  tool: MCPTool;
  toolContext: Context;
} {
  const client = {callTool} as unknown as Client;
  const sessionManager = {
    createSession: vi.fn().mockResolvedValue(client),
    closeSession: vi.fn().mockRejectedValue(new Error('close boom')),
  } as unknown as MCPSessionManager;
  const invocationContext = {
    abortSignal: new AbortController().signal,
    session: {state: {}},
  } as unknown as InvocationContext;
  return {
    tool: new MCPTool(
      {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {type: 'object', properties: {}},
      },
      sessionManager,
    ),
    toolContext: new Context({invocationContext}),
  };
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

  it('propagates the callTool error when closing the session also fails', async () => {
    const {tool, toolContext} = toolWithFailingClose(
      vi.fn().mockRejectedValue(new Error('Call failed')),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to close MCP discovery session',
      expect.objectContaining({message: 'close boom'}),
    );
    warnSpy.mockRestore();
  });

  it('returns the tool result when only the session close fails', async () => {
    const {tool, toolContext} = toolWithFailingClose(
      vi.fn().mockResolvedValue({content: [{type: 'text'}]}),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({content: [{type: 'text'}]});
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to close MCP discovery session',
      expect.objectContaining({message: 'close boom'}),
    );
    warnSpy.mockRestore();
  });
});
