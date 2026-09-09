/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  FeatureName,
  InvocationContext,
  LlmAgent,
  MCPSessionManager,
  MCPTool,
  PluginManager,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {ErrorCode, McpError, Tool} from '@modelcontextprotocol/sdk/types.js';
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
    await withTemporaryFeatureOverride(
      FeatureName.MCP_GRACEFUL_ERROR_HANDLING,
      false,
      async () => {
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
        expect(mockSessionManager.closeSession).toHaveBeenCalledWith(
          mockClient,
        );
      },
    );
  });
});

describe('MCPTool graceful error handling', () => {
  const mcpTool: Tool = {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {type: 'object', properties: {}},
  };

  /** A session manager handing out one client whose call rejects. */
  function failingSessionManager(error: unknown): MCPSessionManager {
    return sessionManagerFor(clientCalling(vi.fn().mockRejectedValue(error)));
  }

  /** A client whose `callTool` is `call`, and which stubs nothing else. */
  function clientCalling(call: Mock): Client {
    const client: Partial<Client> = {callTool: call};
    return client as Client;
  }

  /** A session manager handing out `client`, recording every close. */
  function sessionManagerFor(client: Client): MCPSessionManager {
    return sessionManagerOpening(vi.fn().mockResolvedValue(client));
  }

  /** A session manager whose `createSession` is `open`. */
  function sessionManagerOpening(open: Mock): MCPSessionManager {
    const sessionManager: Partial<MCPSessionManager> = {
      createSession: open,
      closeSession: vi.fn().mockResolvedValue(undefined),
    };
    return sessionManager as MCPSessionManager;
  }

  function contextFor(signal: AbortSignal): Context {
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
      abortSignal: signal,
    });
    return new Context({invocationContext});
  }

  it('reports an MCP protocol error as a tool error', async () => {
    const sessionManager = failingSessionManager(
      new McpError(ErrorCode.InternalError, 'boom'),
    );
    const tool = new MCPTool(mcpTool, sessionManager);

    const result = await tool.runAsync({
      args: {},
      toolContext: contextFor(new AbortController().signal),
    });

    expect(result).toEqual({
      error: 'MCP tool execution failed: MCP error -32603: boom',
    });
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
  });

  it('reports any other error as an unexpected tool error', async () => {
    const sessionManager = failingSessionManager(new Error('Call failed'));
    const tool = new MCPTool(mcpTool, sessionManager);

    const result = await tool.runAsync({
      args: {},
      toolContext: contextFor(new AbortController().signal),
    });

    expect(result).toEqual({
      error: 'Unexpected error during MCP tool execution: Call failed',
    });
  });

  it('reports a session that never opened as a tool error', async () => {
    const sessionManager = sessionManagerOpening(
      vi.fn().mockRejectedValue(new Error('connect refused')),
    );
    const tool = new MCPTool(mcpTool, sessionManager);

    const result = await tool.runAsync({
      args: {},
      toolContext: contextFor(new AbortController().signal),
    });

    expect(result).toEqual({
      error: 'Unexpected error during MCP tool execution: connect refused',
    });
    expect(sessionManager.closeSession).not.toHaveBeenCalled();
  });

  it('throws an AbortError even when the signal is not aborted', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const sessionManager = failingSessionManager(abortError);
    const tool = new MCPTool(mcpTool, sessionManager);

    await expect(
      tool.runAsync({
        args: {},
        toolContext: contextFor(new AbortController().signal),
      }),
    ).rejects.toThrow('The operation was aborted');
  });

  it('throws when the caller aborted the call', async () => {
    const controller = new AbortController();
    controller.abort();
    const sessionManager = failingSessionManager(new Error('Call failed'));
    const tool = new MCPTool(mcpTool, sessionManager);

    await expect(
      tool.runAsync({args: {}, toolContext: contextFor(controller.signal)}),
    ).rejects.toThrow('Call failed');
  });

  it('returns the result of a call that succeeds', async () => {
    const client = clientCalling(vi.fn().mockResolvedValue({content: []}));
    const tool = new MCPTool(mcpTool, sessionManagerFor(client));

    const result = await tool.runAsync({
      args: {},
      toolContext: contextFor(new AbortController().signal),
    });

    expect(result).toEqual({content: []});
  });
});
