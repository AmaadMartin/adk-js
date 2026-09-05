/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LogLevel,
  MCPSessionManager,
  MCPTool,
  PluginManager,
  setLogLevel,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {propagation, TextMapPropagator} from '@opentelemetry/api';
import {afterEach, describe, expect, it, vi} from 'vitest';

// The HTTP debug recorder is internal (not part of the public API), as is the
// logger singleton, so both are imported via a relative path.
import {
  mcpHttpDebugStorage,
  McpHttpExchange,
} from '../../../src/tools/mcp/http_debug_recorder.js';
import {resetLogger} from '../../../src/utils/logger.js';

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
});

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager(),
  });
}

function makeMcpTool(meta?: unknown): Tool {
  return {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {type: 'object', properties: {}},
    // The cast covers only `_meta`: these fixtures model a malformed block
    // from a remote server, which by definition does not fit the SDK type.
    _meta: meta as Tool['_meta'],
  };
}

/**
 * A real {@link MCPSessionManager} whose session handling is stubbed. Building
 * the real classes keeps the fakes typed: neither `Client` nor the manager can
 * be described by an object literal, and a cast would hide a signature drift.
 */
function makeSessionManager(client: Client): MCPSessionManager {
  const manager = new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: 'unused-in-tests'},
  });
  vi.spyOn(manager, 'createSession').mockResolvedValue(client);
  vi.spyOn(manager, 'closeSession').mockResolvedValue(undefined);
  return manager;
}

/** A real MCP {@link Client} whose `callTool` is stubbed. */
function makeClient(callTool: Client['callTool']): Client {
  const client = new Client({name: 'test-client', version: '1.0.0'});
  vi.spyOn(client, 'callTool').mockImplementation(callTool);
  return client;
}

describe('MCPTool.rawMcpTool', () => {
  it('returns the exact object passed to the constructor', () => {
    const mcpTool = makeMcpTool();
    const tool = new MCPTool(mcpTool, makeSessionManager(makeClient(vi.fn())));

    expect(tool.rawMcpTool).toBe(mcpTool);
  });
});

describe('MCPTool.mcpAppResourceUri', () => {
  function uriFor(meta?: unknown): string | undefined {
    const sessionManager = makeSessionManager(makeClient(vi.fn()));
    return new MCPTool(makeMcpTool(meta), sessionManager).mcpAppResourceUri;
  }

  it('reads the nested spelling', () => {
    expect(uriFor({ui: {resourceUri: 'ui://test-resource'}})).toBe(
      'ui://test-resource',
    );
  });

  it('reads the deprecated flat spelling', () => {
    expect(uriFor({'ui/resourceUri': 'ui://test-resource-flat'})).toBe(
      'ui://test-resource-flat',
    );
  });

  it('prefers the nested spelling when both are present', () => {
    expect(
      uriFor({
        'ui': {resourceUri: 'ui://nested'},
        'ui/resourceUri': 'ui://flat',
      }),
    ).toBe('ui://nested');
  });

  it('falls back to the flat spelling when the nested one is not a ui:// URI', () => {
    expect(
      uriFor({
        'ui': {resourceUri: 'http://invalid'},
        'ui/resourceUri': 'ui://flat',
      }),
    ).toBe('ui://flat');
  });

  const absent: Array<[string, unknown]> = [
    ['_meta is absent', undefined],
    ['_meta is null', null],
    ['_meta is not an object', 'ui://not-a-record'],
    ['_meta is empty', {}],
    ['ui is not an object', {ui: 'ui://not-a-record'}],
    ['ui is empty', {ui: {}}],
    ['the resource URI is not a string', {ui: {resourceUri: 42}}],
    ['the resource URI has another scheme', {ui: {resourceUri: 'http://x'}}],
    ['the flat URI has another scheme', {'ui/resourceUri': 'http://x'}],
  ];

  it.each(absent)('is undefined when %s', (_label, meta) => {
    expect(uriFor(meta)).toBeUndefined();
  });
});

describe('MCPTool UI widget rendering', () => {
  function contextWith(functionCallId?: string): Context {
    return new Context({
      invocationContext: makeInvocationContext(),
      functionCallId,
    });
  }

  it('renders one widget after a successful call', async () => {
    const mcpTool = makeMcpTool({ui: {resourceUri: 'ui://test-app'}});
    const client = makeClient(vi.fn().mockResolvedValue({content: []}));
    const tool = new MCPTool(mcpTool, makeSessionManager(client));
    const toolContext = contextWith('test-call-id');
    const args = {query: 'hello'};

    const result = await tool.runAsync({args, toolContext});

    expect(result).toEqual({content: []});
    expect(toolContext.actions.renderUiWidgets).toEqual([
      {
        id: 'test-call-id',
        provider: 'mcp',
        payload: {
          resource_uri: 'ui://test-app',
          tool: mcpTool,
          tool_args: args,
        },
      },
    ]);
  });

  it('renders nothing for a tool that declares no resource URI', async () => {
    const client = makeClient(vi.fn().mockResolvedValue({content: []}));
    const tool = new MCPTool(makeMcpTool(), makeSessionManager(client));
    const toolContext = contextWith('test-call-id');

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });

  it('renders nothing when the call fails', async () => {
    const mcpTool = makeMcpTool({ui: {resourceUri: 'ui://test-app'}});
    const client = makeClient(vi.fn().mockRejectedValue(new Error('boom')));
    const tool = new MCPTool(mcpTool, makeSessionManager(client));
    const toolContext = contextWith('test-call-id');

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'boom',
    );

    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });

  it('renders nothing, and does not throw, without a function call id', async () => {
    const mcpTool = makeMcpTool({ui: {resourceUri: 'ui://test-app'}});
    const client = makeClient(vi.fn().mockResolvedValue({content: []}));
    const tool = new MCPTool(mcpTool, makeSessionManager(client));
    const toolContext = contextWith();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({content: []});
    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });
});

describe('MCPTool trace context propagation', () => {
  const stubPropagator: TextMapPropagator = {
    inject(_context, carrier, setter) {
      setter.set(carrier, 'traceparent', '00-trace-span-01');
      setter.set(carrier, 'tracestate', 'foo=bar');
      setter.set(carrier, 'baggage', 'k=v');
    },
    extract: (context) => context,
    fields: () => ['traceparent', 'tracestate', 'baggage'],
  };

  afterEach(() => {
    propagation.disable();
  });

  async function callToolParams(): Promise<Record<string, unknown>> {
    const callTool = vi.fn().mockResolvedValue({content: []});
    const tool = new MCPTool(
      makeMcpTool(),
      makeSessionManager(makeClient(callTool)),
    );

    await tool.runAsync({
      args: {},
      toolContext: new Context({invocationContext: makeInvocationContext()}),
    });

    return callTool.mock.calls[0][0];
  }

  it('sends the injected carrier as _meta', async () => {
    propagation.setGlobalPropagator(stubPropagator);

    expect(await callToolParams()).toEqual({
      name: 'test-tool',
      arguments: {},
      _meta: {
        traceparent: '00-trace-span-01',
        tracestate: 'foo=bar',
        baggage: 'k=v',
      },
    });
  });

  it('sends no _meta key at all when no propagator is registered', async () => {
    propagation.disable();

    expect(await callToolParams()).not.toHaveProperty('_meta');
  });
});

describe('MCPTool HTTP debug capture', () => {
  const exchange: McpHttpExchange = {
    url: 'http://test-url/mcp',
    method: 'POST',
    status: 200,
    durationMs: 1,
    requestHeaders: {authorization: '<redacted>'},
    responseHeaders: {'content-type': 'application/json'},
  };

  /** A `callTool` that records one exchange, as the recording fetch would. */
  function recordingCallTool(result: () => Promise<unknown>) {
    return vi.fn().mockImplementation(() => {
      mcpHttpDebugStorage.getStore()?.push({...exchange});
      return result();
    });
  }

  function toolFor(callTool: Client['callTool']): MCPTool {
    return new MCPTool(makeMcpTool(), makeSessionManager(makeClient(callTool)));
  }

  afterEach(() => {
    resetLogger();
  });

  it('drains the recording on the success path', async () => {
    setLogLevel(LogLevel.DEBUG);
    const toolContext = new Context({
      invocationContext: makeInvocationContext(),
    });
    const tool = toolFor(recordingCallTool(async () => ({content: []})));

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata['http_debug_info']).toEqual([exchange]);
  });

  it('drains the recording when the call throws, and rethrows', async () => {
    setLogLevel(LogLevel.DEBUG);
    const toolContext = new Context({
      invocationContext: makeInvocationContext(),
    });
    const tool = toolFor(
      recordingCallTool(() => Promise.reject(new Error('call failed'))),
    );

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'call failed',
    );

    expect(toolContext.customMetadata['http_debug_info']).toEqual([exchange]);
  });

  it('appends a second call onto the first call\u2019s recording', async () => {
    setLogLevel(LogLevel.DEBUG);
    const toolContext = new Context({
      invocationContext: makeInvocationContext(),
    });
    const tool = toolFor(recordingCallTool(async () => ({content: []})));

    await tool.runAsync({args: {}, toolContext});
    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata['http_debug_info']).toEqual([
      exchange,
      exchange,
    ]);
  });

  it('records nothing when the call makes no HTTP request', async () => {
    setLogLevel(LogLevel.DEBUG);
    const toolContext = new Context({
      invocationContext: makeInvocationContext(),
    });
    const tool = toolFor(vi.fn().mockResolvedValue({content: []}));

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata).not.toHaveProperty('http_debug_info');
  });

  it('installs no sink when the log level is above debug', async () => {
    setLogLevel(LogLevel.INFO);
    const toolContext = new Context({
      invocationContext: makeInvocationContext(),
    });
    const callTool = vi.fn().mockImplementation(async () => {
      expect(mcpHttpDebugStorage.getStore()).toBeUndefined();
      return {content: []};
    });

    await toolFor(callTool).runAsync({args: {}, toolContext});

    expect(callTool).toHaveBeenCalledOnce();
    expect(toolContext.customMetadata).not.toHaveProperty('http_debug_info');
  });
});
