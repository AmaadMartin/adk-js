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
import {propagation} from '@opentelemetry/api';
import type {MockInstance} from 'vitest';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  getHttpDebugSink,
  HttpDebugExchange,
} from '../../../src/tools/mcp/http_debug_recorder.js';
import {isRecord} from '../../../src/utils/type_utils.js';

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

/** A tool declaration carrying whatever extra fields the server sent. */
function toolWithExtras(extras: Record<string, unknown> = {}): Tool {
  return {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {type: 'object', properties: {}},
    ...extras,
  };
}

/** A tool declaration carrying `_meta` exactly when the server sent one. */
function toolWithMeta(meta?: unknown): Tool {
  return toolWithExtras(meta === undefined ? {} : {_meta: meta});
}

function makeToolContext(
  functionCallId?: string,
  abortSignal?: AbortSignal,
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'i-1',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
      abortSignal,
    }),
    functionCallId,
  });
}

/**
 * A real session manager handing out a real client, with the session methods
 * and `callTool` stubbed so no transport is opened.
 */
function makeSessionManager(callTool: ReturnType<typeof vi.fn> = vi.fn()): {
  manager: MCPSessionManager;
  client: Client;
  createSession: MockInstance<MCPSessionManager['createSession']>;
  closeSession: MockInstance<MCPSessionManager['closeSession']>;
} {
  const client = new Client({name: 'test-client', version: '1.0.0'});
  vi.spyOn(client, 'callTool').mockImplementation(callTool);
  vi.spyOn(client, 'close').mockResolvedValue(undefined);

  const manager = new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: 'unused'},
  });
  return {
    manager,
    client,
    createSession: vi.spyOn(manager, 'createSession').mockResolvedValue(client),
    closeSession: vi
      .spyOn(manager, 'closeSession')
      .mockResolvedValue(undefined),
  };
}

describe('MCPTool.mcpAppResourceUri', () => {
  it('reads the nested form', () => {
    const tool = new MCPTool(
      toolWithMeta({ui: {resourceUri: 'ui://demo/card'}}),
      makeSessionManager().manager,
    );
    expect(tool.mcpAppResourceUri).toBe('ui://demo/card');
  });

  it('reads the flat form', () => {
    const tool = new MCPTool(
      toolWithMeta({'ui/resourceUri': 'ui://demo/card'}),
      makeSessionManager().manager,
    );
    expect(tool.mcpAppResourceUri).toBe('ui://demo/card');
  });

  it('falls back to the flat form when the nested one is not a ui:// URI', () => {
    const tool = new MCPTool(
      toolWithMeta({
        ui: {resourceUri: 'http://demo/card'},
        'ui/resourceUri': 'ui://demo/flat',
      }),
      makeSessionManager().manager,
    );
    expect(tool.mcpAppResourceUri).toBe('ui://demo/flat');
  });

  it.each([
    ['no _meta at all', undefined],
    ['a string _meta', 'ui://demo/card'],
    ['an array _meta', [{resourceUri: 'ui://demo/card'}]],
    ['a null _meta', null],
    ['a non-object ui', {ui: 'ui://demo/card'}],
    ['an array ui', {ui: ['ui://demo/card']}],
    ['a non-string resource URI', {ui: {resourceUri: 42}}],
    ['a non-ui scheme', {ui: {resourceUri: 'http://demo/card'}}],
    ['a non-ui scheme in the flat form', {'ui/resourceUri': 'http://demo'}],
    ['an unrelated _meta key', {other: 'value'}],
  ])('returns undefined for %s', (_label, meta) => {
    const tool = new MCPTool(toolWithMeta(meta), makeSessionManager().manager);
    expect(tool.mcpAppResourceUri).toBeUndefined();
  });
});

describe('MCPTool.rawMcpTool', () => {
  it('returns the declaration object it was given', () => {
    const declaration = toolWithMeta();
    const tool = new MCPTool(declaration, makeSessionManager().manager);

    expect(tool.rawMcpTool).toBe(declaration);
  });

  it('exposes a server field the wrapper does not model', () => {
    const declaration = toolWithExtras({vendorSpecificField: {tier: 'gold'}});
    const tool = new MCPTool(declaration, makeSessionManager().manager);

    const raw: unknown = tool.rawMcpTool;
    if (!isRecord(raw)) {
      expect.fail('expected the raw tool to be a record');
    }
    expect(raw['vendorSpecificField']).toEqual({tier: 'gold'});
  });
});

describe('MCPTool UI widget', () => {
  it('pushes one widget after a successful call', async () => {
    const declaration = toolWithMeta({ui: {resourceUri: 'ui://demo/card'}});
    const {manager} = makeSessionManager(
      vi.fn().mockResolvedValue({content: []}),
    );
    const tool = new MCPTool(declaration, manager);
    const toolContext = makeToolContext('call-1');

    await tool.runAsync({args: {city: 'Paris'}, toolContext});

    expect(toolContext.actions.renderUiWidgets).toEqual([
      {
        id: 'call-1',
        provider: 'mcp',
        payload: {
          resource_uri: 'ui://demo/card',
          tool: declaration,
          tool_args: {city: 'Paris'},
        },
      },
    ]);
  });

  it('pushes nothing when the tool declares no resource URI', async () => {
    const {manager} = makeSessionManager(
      vi.fn().mockResolvedValue({content: []}),
    );
    const tool = new MCPTool(toolWithMeta(), manager);
    const toolContext = makeToolContext('call-1');

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });

  it('pushes nothing when there is no function call id to key it by', async () => {
    const {manager} = makeSessionManager(
      vi.fn().mockResolvedValue({content: []}),
    );
    const tool = new MCPTool(
      toolWithMeta({ui: {resourceUri: 'ui://demo/card'}}),
      manager,
    );
    const toolContext = makeToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });

  it('pushes nothing when the call fails', async () => {
    const {manager} = makeSessionManager(
      vi.fn().mockRejectedValue(new Error('Call failed')),
    );
    const tool = new MCPTool(
      toolWithMeta({ui: {resourceUri: 'ui://demo/card'}}),
      manager,
    );
    const toolContext = makeToolContext('call-1');

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );
    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });
});

describe('MCPTool trace context', () => {
  afterEach(() => {
    propagation.disable();
  });

  it('sends the injected carrier as the request _meta', async () => {
    propagation.setGlobalPropagator({
      inject(_context, carrier, setter) {
        setter.set(carrier, 'traceparent', '00-trace-span-01');
        setter.set(carrier, 'tracestate', 'vendor=1');
        setter.set(carrier, 'baggage', 'key=value');
      },
      extract: (context) => context,
      fields: () => ['traceparent', 'tracestate', 'baggage'],
    });
    const callTool = vi.fn().mockResolvedValue({content: []});
    const {manager} = makeSessionManager(callTool);
    const tool = new MCPTool(toolWithMeta(), manager);

    await tool.runAsync({args: {}, toolContext: makeToolContext('call-1')});

    expect(callTool).toHaveBeenCalledWith(
      {
        name: 'test-tool',
        arguments: {},
        _meta: {
          traceparent: '00-trace-span-01',
          tracestate: 'vendor=1',
          baggage: 'key=value',
        },
      },
      undefined,
      {signal: undefined},
    );
  });

  it('omits _meta when the carrier stays empty', async () => {
    const callTool = vi.fn().mockResolvedValue({content: []});
    const {manager} = makeSessionManager(callTool);
    const tool = new MCPTool(toolWithMeta(), manager);

    await tool.runAsync({args: {}, toolContext: makeToolContext('call-1')});

    expect(callTool.mock.calls[0][0]).not.toHaveProperty('_meta');
  });
});

describe('MCPTool HTTP debug capture', () => {
  const exchange: HttpDebugExchange = {
    url: 'https://mcp.example/mcp',
    status_code: 403,
    method: 'POST',
    request_headers: {authorization: '<redacted>'},
    response_headers: {'content-type': 'application/json'},
  };

  /** A `callTool` that records an exchange the way the transport would. */
  function recordingCallTool(result: 'resolve' | 'reject') {
    return vi.fn().mockImplementation(() => {
      getHttpDebugSink()?.push(exchange);
      return result === 'resolve'
        ? Promise.resolve({content: []})
        : Promise.reject(new Error('403 from the gateway'));
    });
  }

  afterEach(() => {
    setLogLevel(LogLevel.ERROR);
  });

  it('lands the recorded exchange on the invocation metadata', async () => {
    setLogLevel(LogLevel.DEBUG);
    const {manager} = makeSessionManager(recordingCallTool('resolve'));
    const tool = new MCPTool(toolWithMeta(), manager);
    const toolContext = makeToolContext('call-1');

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata['http_debug_info']).toEqual([exchange]);
  });

  it('leaves the key absent when debug logging is off', async () => {
    const {manager} = makeSessionManager(recordingCallTool('resolve'));
    const tool = new MCPTool(toolWithMeta(), manager);
    const toolContext = makeToolContext('call-1');

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata).toEqual({});
  });

  it('leaves the key absent when nothing was recorded', async () => {
    setLogLevel(LogLevel.DEBUG);
    const {manager} = makeSessionManager(
      vi.fn().mockResolvedValue({content: []}),
    );
    const tool = new MCPTool(toolWithMeta(), manager);
    const toolContext = makeToolContext('call-1');

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata).toEqual({});
  });

  it('records exactly one exchange when the call fails, and rethrows', async () => {
    setLogLevel(LogLevel.DEBUG);
    const callTool = recordingCallTool('reject');
    const {manager, createSession} = makeSessionManager(callTool);
    const tool = new MCPTool(toolWithMeta(), manager);
    const toolContext = makeToolContext('call-1');

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      '403 from the gateway',
    );

    // A tool call is at-most-once, including after an ambiguous failure.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(toolContext.customMetadata['http_debug_info']).toEqual([exchange]);
  });

  it('appends to exchanges an earlier call already recorded', async () => {
    setLogLevel(LogLevel.DEBUG);
    const {manager} = makeSessionManager(recordingCallTool('resolve'));
    const tool = new MCPTool(toolWithMeta(), manager);
    const toolContext = makeToolContext('call-1');

    await tool.runAsync({args: {}, toolContext});
    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata['http_debug_info']).toEqual([
      exchange,
      exchange,
    ]);
  });
});

describe('MCPTool session setup retry', () => {
  it('retries session setup once and then calls the tool', async () => {
    const callTool = vi.fn().mockResolvedValue({content: []});
    const {manager, client, createSession} = makeSessionManager(callTool);
    createSession
      .mockReset()
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockResolvedValue(client);

    await new MCPTool(toolWithMeta(), manager).runAsync({
      args: {},
      toolContext: makeToolContext('call-1'),
    });

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('gives up after the second setup attempt fails', async () => {
    const callTool = vi.fn().mockResolvedValue({content: []});
    const {manager, createSession, closeSession} = makeSessionManager(callTool);
    createSession
      .mockReset()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));

    await expect(
      new MCPTool(toolWithMeta(), manager).runAsync({
        args: {},
        toolContext: makeToolContext('call-1'),
      }),
    ).rejects.toThrow('second');

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(closeSession).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('does not retry session setup after an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const {manager, createSession} = makeSessionManager();
    createSession.mockReset().mockRejectedValue(new Error('connect refused'));
    const toolContext = makeToolContext('call-1', controller.signal);

    await expect(
      new MCPTool(toolWithMeta(), manager).runAsync({args: {}, toolContext}),
    ).rejects.toThrow('connect refused');

    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
