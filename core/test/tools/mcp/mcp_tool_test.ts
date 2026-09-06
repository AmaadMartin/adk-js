/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  MCPConnectionParams,
  MCPSessionManager,
  MCPTool,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, vi} from 'vitest';
// The logger singleton is internal (not part of the public API), so it is
// imported via a relative path to spy on the exact instance the tool uses.
import {logger} from '../../../src/utils/logger.js';

import {clientStub, createTestToolContext} from './mcp_context_test_utils.js';

const stdioParams: MCPConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test'},
};

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
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    /** A session manager whose sessions record the `callTool` options. */
    function stubSessionManager(): {
      manager: MCPSessionManager;
      callTool: ReturnType<typeof vi.fn>;
    } {
      const callTool = vi.fn().mockResolvedValue({content: []});
      const manager = new MCPSessionManager(stdioParams);
      vi.spyOn(manager, 'createSession').mockResolvedValue(
        clientStub({callTool}),
      );
      vi.spyOn(manager, 'closeSession').mockResolvedValue(undefined);
      return {manager, callTool};
    }

    /** Lets every queued microtask run, including a rejected callback. */
    function flushMicrotasks(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    function toolContext(): Context {
      return createTestToolContext();
    }

    it('passes no onprogress when no callback is configured', async () => {
      const {manager, callTool} = stubSessionManager();
      const tool = new MCPTool(mockTool, manager);

      await tool.runAsync({args: {}, toolContext: toolContext()});

      expect(callTool.mock.calls[0][2].onprogress).toBeUndefined();
    });

    it('forwards a progress notification to the callback', async () => {
      const {manager, callTool} = stubSessionManager();
      const progressCallback = vi.fn();
      const tool = new MCPTool(mockTool, manager, undefined, {
        progressCallback,
      });

      await tool.runAsync({args: {}, toolContext: toolContext()});
      callTool.mock.calls[0][2].onprogress({progress: 3, total: 10});
      await flushMicrotasks();

      expect(progressCallback).toHaveBeenCalledWith({progress: 3, total: 10});
    });

    it('logs a rejecting callback instead of failing the call', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const {manager, callTool} = stubSessionManager();
      const tool = new MCPTool(mockTool, manager, undefined, {
        progressCallback: () => Promise.reject(new Error('progress boom')),
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: toolContext(),
      });
      callTool.mock.calls[0][2].onprogress({progress: 1});
      await flushMicrotasks();

      expect(result).toEqual({content: []});
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('progress boom'),
      );
      warn.mockRestore();
    });

    it('logs a callback that throws synchronously', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const {manager, callTool} = stubSessionManager();
      const tool = new MCPTool(mockTool, manager, undefined, {
        progressCallback: () => {
          throw new Error('sync progress boom');
        },
      });

      await tool.runAsync({args: {}, toolContext: toolContext()});
      callTool.mock.calls[0][2].onprogress({progress: 1});
      await flushMicrotasks();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('sync progress boom'),
      );
      warn.mockRestore();
    });
  });

  describe('declaration', () => {
    it('translates the MCP schemas into a function declaration', () => {
      const tool = new MCPTool(
        {
          name: 'test-tool',
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: {path: {type: 'string'}},
          },
          outputSchema: {
            type: 'object',
            properties: {size: {type: 'number'}},
          },
        },
        new MCPSessionManager(stdioParams),
      );

      expect(tool._getDeclaration()).toMatchObject({
        name: 'test-tool',
        description: 'A test tool',
        parameters: {properties: {path: {type: 'STRING'}}},
        response: {properties: {size: {type: 'NUMBER'}}},
      });
    });

    it('describes a tool the server gave no description as empty', () => {
      const tool = new MCPTool(
        {name: 'bare-tool', inputSchema: {type: 'object', properties: {}}},
        new MCPSessionManager(stdioParams),
      );

      expect(tool.description).toBe('');
    });
  });
});
