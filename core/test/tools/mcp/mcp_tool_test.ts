/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  HttpDebugRecord,
  InvocationContext,
  LogLevel,
  MCPSessionManager,
  MCPTool,
  PluginManager,
  createSession,
  setLogLevel,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {propagation} from '@opentelemetry/api';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {recordHttpDebug} from '../../../src/utils/http_debug_utils.js';
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

function createMcpTool(meta?: Record<string, unknown>): Tool {
  return {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: {type: 'object', properties: {}},
    ...(meta && {_meta: meta}),
  };
}

/** A real client whose only live method is the stubbed `callTool`. */
function createClient(): Client {
  const client = new Client({name: 'test-client', version: '1.0.0'});
  vi.spyOn(client, 'callTool').mockResolvedValue({content: []});
  return client;
}

/** A real session manager that hands out `clients` and never connects. */
function createSessionManager(...clients: Client[]): MCPSessionManager {
  const manager = new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: 'unused'},
  });
  const createSession = vi.spyOn(manager, 'createSession');
  for (const client of clients) {
    createSession.mockResolvedValueOnce(client);
  }
  vi.spyOn(manager, 'closeSession').mockResolvedValue(undefined);
  return manager;
}

function createToolContext(
  options: {
    functionCallId?: string;
    abortSignal?: AbortSignal;
    customMetadata?: Record<string, unknown>;
  } = {},
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'test-session',
      appName: 'app',
      userId: 'user',
    }),
    pluginManager: new PluginManager(),
    abortSignal: options.abortSignal,
    customMetadata: options.customMetadata,
  });
  return new Context({
    invocationContext,
    functionCallId: options.functionCallId,
  });
}

/** An error shaped like a Node connect-phase failure. */
function connectionError(code = 'ECONNREFUSED'): Error {
  return Object.assign(new Error(`connect ${code}`), {code});
}

describe('MCPTool.rawMcpTool', () => {
  it('returns the tool definition the constructor received', () => {
    const mcpTool = createMcpTool();
    const tool = new MCPTool(mcpTool, createSessionManager());

    expect(tool.rawMcpTool).toBe(mcpTool);
  });
});

describe('MCPTool.mcpAppResourceUri', () => {
  it('reads the nested ui.resourceUri', () => {
    const tool = new MCPTool(
      createMcpTool({ui: {resourceUri: 'ui://test-resource'}}),
      createSessionManager(),
    );

    expect(tool.mcpAppResourceUri).toBe('ui://test-resource');
  });

  it('reads the flat ui/resourceUri', () => {
    const tool = new MCPTool(
      createMcpTool({'ui/resourceUri': 'ui://test-resource-flat'}),
      createSessionManager(),
    );

    expect(tool.mcpAppResourceUri).toBe('ui://test-resource-flat');
  });

  it('prefers the nested spelling over the deprecated flat one', () => {
    const tool = new MCPTool(
      createMcpTool({
        ui: {resourceUri: 'ui://nested'},
        'ui/resourceUri': 'ui://flat',
      }),
      createSessionManager(),
    );

    expect(tool.mcpAppResourceUri).toBe('ui://nested');
  });

  it('returns undefined when the tool declares no _meta', () => {
    const tool = new MCPTool(createMcpTool(), createSessionManager());

    expect(tool.mcpAppResourceUri).toBeUndefined();
  });

  it('returns undefined when _meta is empty', () => {
    const tool = new MCPTool(createMcpTool({}), createSessionManager());

    expect(tool.mcpAppResourceUri).toBeUndefined();
  });

  it('returns undefined when _meta is not an object', () => {
    // A remote server controls _meta, so it can be any JSON value.
    const mcpTool = Object.assign(createMcpTool(), {_meta: 'not-an-object'});
    const tool = new MCPTool(mcpTool, createSessionManager());

    expect(tool.mcpAppResourceUri).toBeUndefined();
  });

  it('returns undefined when ui is not an object', () => {
    const tool = new MCPTool(
      createMcpTool({ui: 'not-an-object'}),
      createSessionManager(),
    );

    expect(tool.mcpAppResourceUri).toBeUndefined();
  });

  it('returns undefined when resourceUri is not a string', () => {
    const tool = new MCPTool(
      createMcpTool({ui: {resourceUri: 42}}),
      createSessionManager(),
    );

    expect(tool.mcpAppResourceUri).toBeUndefined();
  });

  it('returns undefined for a URI outside the ui:// scheme', () => {
    const tool = new MCPTool(
      createMcpTool({ui: {resourceUri: 'https://example.com/app'}}),
      createSessionManager(),
    );

    expect(tool.mcpAppResourceUri).toBeUndefined();
  });
});

describe('MCPTool UI widget', () => {
  it('renders an MCP App widget after a successful call', async () => {
    const mcpTool = createMcpTool({ui: {resourceUri: 'ui://test-app'}});
    const tool = new MCPTool(mcpTool, createSessionManager(createClient()));
    const toolContext = createToolContext({functionCallId: 'test-call-id'});

    await tool.runAsync({args: {city: 'Paris'}, toolContext});

    expect(toolContext.actions.renderUiWidgets).toEqual([
      {
        id: 'test-call-id',
        provider: 'mcp',
        payload: {
          resource_uri: 'ui://test-app',
          tool: mcpTool,
          tool_args: {city: 'Paris'},
        },
      },
    ]);
    expect(toolContext.actions.renderUiWidgets?.[0].payload['tool']).toBe(
      mcpTool,
    );
  });

  it('renders no widget when the tool declares no resource URI', async () => {
    const tool = new MCPTool(
      createMcpTool(),
      createSessionManager(createClient()),
    );
    const toolContext = createToolContext({functionCallId: 'test-call-id'});

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });

  it('renders no widget when the tool context has no function call id', async () => {
    const tool = new MCPTool(
      createMcpTool({ui: {resourceUri: 'ui://test-app'}}),
      createSessionManager(createClient()),
    );
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });

  it('renders no widget when the call fails', async () => {
    const client = createClient();
    vi.spyOn(client, 'callTool').mockRejectedValue(new Error('Call failed'));
    const tool = new MCPTool(
      createMcpTool({ui: {resourceUri: 'ui://test-app'}}),
      createSessionManager(client),
    );
    const toolContext = createToolContext({functionCallId: 'test-call-id'});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );

    expect(toolContext.actions.renderUiWidgets).toBeUndefined();
  });
});

describe('MCPTool trace context propagation', () => {
  afterEach(() => {
    propagation.disable();
  });

  it('sends the active trace context in the call _meta', async () => {
    propagation.setGlobalPropagator({
      inject(_ctx, carrier, setter) {
        setter.set(carrier, 'traceparent', 'test-traceparent');
      },
      extract: (ctx) => ctx,
      fields: () => ['traceparent'],
    });
    const client = createClient();
    const tool = new MCPTool(createMcpTool(), createSessionManager(client));
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect(client.callTool).toHaveBeenCalledWith(
      {
        name: 'test-tool',
        arguments: {},
        _meta: {traceparent: 'test-traceparent'},
      },
      undefined,
      {signal: toolContext.abortSignal},
    );
  });

  it('omits _meta entirely when no trace context is active', async () => {
    const client = createClient();
    const tool = new MCPTool(createMcpTool(), createSessionManager(client));
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    const params = vi.mocked(client.callTool).mock.calls[0][0];
    expect('_meta' in params).toBe(false);
  });
});

describe('MCPTool http_debug_info capture', () => {
  const record: HttpDebugRecord = {
    url: 'https://mcp.example.com/mcp',
    status_code: 200,
    method: 'POST',
    request_headers: {authorization: '<redacted>'},
    response_headers: {'content-type': 'application/json'},
  };

  afterEach(() => {
    resetLogger();
  });

  it('publishes the exchanges captured during the call', async () => {
    setLogLevel(LogLevel.DEBUG);
    const client = createClient();
    vi.spyOn(client, 'callTool').mockImplementation(async () => {
      recordHttpDebug(record);
      return {content: []};
    });
    const tool = new MCPTool(createMcpTool(), createSessionManager(client));
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata['http_debug_info']).toEqual([record]);
  });

  it('records nothing when debug logging is off', async () => {
    setLogLevel(LogLevel.INFO);
    const client = createClient();
    vi.spyOn(client, 'callTool').mockImplementation(async () => {
      recordHttpDebug(record);
      return {content: []};
    });
    const tool = new MCPTool(createMcpTool(), createSessionManager(client));
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect('http_debug_info' in toolContext.customMetadata).toBe(false);
  });

  it('adds no key when the call performed no HTTP exchange', async () => {
    setLogLevel(LogLevel.DEBUG);
    const tool = new MCPTool(
      createMcpTool(),
      createSessionManager(createClient()),
    );
    const toolContext = createToolContext();

    await tool.runAsync({args: {}, toolContext});

    expect('http_debug_info' in toolContext.customMetadata).toBe(false);
  });

  it('publishes the exchanges captured before the call failed', async () => {
    setLogLevel(LogLevel.DEBUG);
    const client = createClient();
    vi.spyOn(client, 'callTool').mockImplementation(async () => {
      recordHttpDebug(record);
      throw new Error('Call failed');
    });
    const tool = new MCPTool(createMcpTool(), createSessionManager(client));
    const toolContext = createToolContext();

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );

    expect(toolContext.customMetadata['http_debug_info']).toEqual([record]);
  });

  it('extends an http_debug_info list an earlier call left behind', async () => {
    setLogLevel(LogLevel.DEBUG);
    const earlier = {...record, status_code: 500};
    const client = createClient();
    vi.spyOn(client, 'callTool').mockImplementation(async () => {
      recordHttpDebug(record);
      return {content: []};
    });
    const tool = new MCPTool(createMcpTool(), createSessionManager(client));
    const toolContext = createToolContext({
      customMetadata: {http_debug_info: [earlier]},
    });

    await tool.runAsync({args: {}, toolContext});

    expect(toolContext.customMetadata['http_debug_info']).toEqual([
      earlier,
      record,
    ]);
  });
});

describe('MCPTool session retry', () => {
  it('opens a second session when the first one fails to open', async () => {
    const succeeding = createClient();
    const manager = createSessionManager();
    vi.mocked(manager.createSession)
      .mockRejectedValueOnce(new Error('Failed to create MCP session: refused'))
      .mockResolvedValueOnce(succeeding);
    const tool = new MCPTool(createMcpTool(), manager);

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(manager.createSession).toHaveBeenCalledTimes(2);
    expect(succeeding.callTool).toHaveBeenCalledTimes(1);
  });

  it('surfaces the second failure when the retry fails too', async () => {
    const manager = createSessionManager();
    vi.mocked(manager.createSession)
      .mockRejectedValueOnce(new Error('first refused'))
      .mockRejectedValueOnce(new Error('second refused'));
    const tool = new MCPTool(createMcpTool(), manager);

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow('second refused');
    expect(manager.createSession).toHaveBeenCalledTimes(2);
  });

  it('does not reopen a session for a cancelled call', async () => {
    const controller = new AbortController();
    controller.abort();
    const manager = createSessionManager();
    vi.mocked(manager.createSession).mockRejectedValue(new Error('refused'));
    const tool = new MCPTool(createMcpTool(), manager);
    const toolContext = createToolContext({abortSignal: controller.signal});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'refused',
    );
    expect(manager.createSession).toHaveBeenCalledTimes(1);
  });

  it('never replays a call the server may have received', async () => {
    // A socket cut mid-call is ambiguous, so replaying it could duplicate a
    // remote side effect. Delivery stays at-most-once.
    const client = createClient();
    vi.spyOn(client, 'callTool').mockRejectedValue(
      connectionError('ECONNRESET'),
    );
    const manager = createSessionManager(client);
    const tool = new MCPTool(createMcpTool(), manager);

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow('connect ECONNRESET');
    expect(manager.createSession).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('does not replay a protocol error the server answered with', async () => {
    const client = createClient();
    vi.spyOn(client, 'callTool').mockRejectedValue(new Error('tool exploded'));
    const manager = createSessionManager(client);
    const tool = new MCPTool(createMcpTool(), manager);

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow('tool exploded');
    expect(manager.createSession).toHaveBeenCalledTimes(1);
  });

  it('closes the session it opened when the call fails', async () => {
    const client = createClient();
    vi.spyOn(client, 'callTool').mockRejectedValue(connectionError());
    const manager = createSessionManager(client);
    const tool = new MCPTool(createMcpTool(), manager);

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow('connect ECONNREFUSED');
    expect(manager.closeSession).toHaveBeenCalledWith(client);
  });
});
