/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  AuthScheme,
  Context,
  createSession,
  FeatureName,
  InvocationContext,
  LlmAgent,
  LogLevel,
  MCPConnectionParams,
  McpProgressCallback,
  MCPSessionManager,
  MCPTool,
  McpToolOptions,
  overrideFeatureEnabled,
  PluginManager,
  setLogLevel,
  ToolConfirmation,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {
  ErrorCode,
  McpError,
  Progress,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {propagation} from '@opentelemetry/api';
import type {MockInstance} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {
  getHttpDebugSink,
  HttpDebugExchange,
} from '../../../src/tools/mcp/http_debug_recorder.js';
// The logger singleton is internal (not part of the public API), so it is
// imported via a relative path to spy on the exact instance the tool uses.
import {logger} from '../../../src/utils/logger.js';
import {isRecord} from '../../../src/utils/type_utils.js';

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

const TOOL_DEFINITION: Tool = {
  name: 'test-tool',
  description: 'A test tool',
  inputSchema: {type: 'object', properties: {}},
};

const OAUTH2_SCHEME: AuthScheme = {type: 'oauth2', flows: {}};

const API_KEY = 'my_api_key';

/** A connected client whose remote calls are stubbed. */
function createClient(): Client {
  const client = new Client({name: 'test-client', version: '1.0.0'});
  vi.spyOn(client, 'callTool').mockResolvedValue({content: []});
  vi.spyOn(client, 'close').mockResolvedValue(undefined);
  return client;
}

/** A session manager that hands out `client` without touching a transport. */
function createSessionManager(client: Client): MCPSessionManager {
  const manager = new MCPSessionManager({
    type: 'StreamableHTTPConnectionParams',
    url: 'http://test-url',
  });
  vi.spyOn(manager, 'createSession').mockResolvedValue(client);
  vi.spyOn(manager, 'closeSession').mockResolvedValue(undefined);
  return manager;
}

function createContext(
  options: {
    toolConfirmation?: ToolConfirmation;
    signal?: AbortSignal;
    state?: Record<string, unknown>;
  } = {},
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      state: options.state,
    }),
    pluginManager: new PluginManager(),
    abortSignal: options.signal ?? new AbortController().signal,
  });
  return new Context({
    invocationContext,
    functionCallId: 'test-function-call-id',
    toolConfirmation: options.toolConfirmation,
  });
}

/** The headers the tool asked the session manager for. */
function sessionHeaders(
  manager: MCPSessionManager,
): Record<string, string> | undefined {
  return vi.mocked(manager.createSession).mock.calls[0]?.[0]?.headers;
}

/** The per-request options the tool passed to `callTool`. */
function callOptions(client: Client) {
  return vi.mocked(client.callTool).mock.calls[0]?.[2];
}

/**
 * Runs the tool once and returns the headers it derived, so that a credential
 * is exercised through the public `runAsync` surface.
 */
async function runAndCollectHeaders(
  options: McpToolOptions,
  state?: Record<string, unknown>,
): Promise<Record<string, string> | undefined> {
  const client = createClient();
  const manager = createSessionManager(client);
  const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, options);
  await tool.runAsync({args: {}, toolContext: createContext({state})});
  return sessionHeaders(manager);
}

/**
 * Makes a failed call throw for every test in the enclosing block. These tests
 * observe a failure as a thrown error, which
 * {@link FeatureName.MCP_GRACEFUL_ERROR_HANDLING} reports as an `{error}`
 * result instead.
 */
function throwOnFailure(): void {
  beforeEach(() => {
    overrideFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING, false);
  });
  afterEach(() => {
    overrideFeatureEnabled(FeatureName.MCP_GRACEFUL_ERROR_HANDLING, undefined);
  });
}

describe('MCPTool reserved names', () => {
  it.each([
    'adk_request_credential',
    'adk_request_confirmation',
    'adk_request_input',
    'transfer_to_agent',
  ])('refuses the reserved name %s', (name) => {
    const manager = createSessionManager(createClient());

    expect(() => new MCPTool({...TOOL_DEFINITION, name}, manager)).toThrow(
      `MCP tool name '${name}' collides with a reserved ADK tool name.`,
    );
  });

  it('allows a name that only starts with a reserved one', () => {
    const manager = createSessionManager(createClient());

    const tool = new MCPTool(
      {...TOOL_DEFINITION, name: 'transfer_to_agent_v2'},
      manager,
    );

    expect(tool.name).toBe('transfer_to_agent_v2');
  });
});

describe('MCPTool auth headers', () => {
  throwOnFailure();

  it('sends a bearer token for an OAuth2 credential', async () => {
    const headers = await runAndCollectHeaders({
      authScheme: OAUTH2_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'test_token'},
      },
    });

    expect(headers).toEqual({Authorization: 'Bearer test_token'});
  });

  it('sends a bearer token for an HTTP bearer credential', async () => {
    const headers = await runAndCollectHeaders({
      authCredential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'bearer_token'}},
      },
    });

    expect(headers).toEqual({Authorization: 'Bearer bearer_token'});
  });

  it('encodes an HTTP basic credential', async () => {
    const headers = await runAndCollectHeaders({
      authCredential: {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'basic',
          credentials: {username: 'user', password: 'pass'},
        },
      },
    });

    expect(headers).toEqual({Authorization: 'Basic dXNlcjpwYXNz'});
  });

  it('sends no authorization for an HTTP basic credential without a password', async () => {
    const headers = await runAndCollectHeaders({
      authCredential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'user'}},
      },
    });

    expect(headers).toBeUndefined();
  });

  it('keeps the spelling of a custom HTTP scheme', async () => {
    const headers = await runAndCollectHeaders({
      authCredential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'custom', credentials: {token: 'custom_token'}},
      },
    });

    expect(headers).toEqual({Authorization: 'custom custom_token'});
  });

  it('merges additionalHeaders on top of a token header', async () => {
    const headers = await runAndCollectHeaders({
      authCredential: {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'some-scheme',
          credentials: {token: 'some_token'},
          additionalHeaders: {'X-Custom-Header': 'custom-value'},
        },
      },
    });

    expect(headers).toEqual({
      'Authorization': 'some-scheme some_token',
      'X-Custom-Header': 'custom-value',
    });
  });

  it('sends additionalHeaders even when no token produced a header', async () => {
    const headers = await runAndCollectHeaders({
      authCredential: {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'some-scheme',
          credentials: {},
          additionalHeaders: {'X-Custom-Header': 'custom-value'},
        },
      },
    });

    expect(headers).toEqual({'X-Custom-Header': 'custom-value'});
  });

  it('sends an API key in the configured header', async () => {
    const headers = await runAndCollectHeaders({
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Custom-API-Key'},
      authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: API_KEY},
    });

    expect(headers).toEqual({'X-Custom-API-Key': API_KEY});
  });

  it.each(['query', 'cookie'] as const)(
    'refuses an API key configured in the %s',
    async (location) => {
      const promise = runAndCollectHeaders({
        authScheme: {type: 'apiKey', in: location, name: 'api_key'},
        authCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: API_KEY,
        },
      });

      await expect(promise).rejects.toThrow(
        `McpTool only supports header-based API key authentication. Configured location: ${location}`,
      );
    },
  );

  it('refuses an API key configured under a non-apiKey scheme', async () => {
    const promise = runAndCollectHeaders({
      authScheme: {type: 'http', scheme: 'bearer'},
      authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: API_KEY},
    });

    await expect(promise).rejects.toThrow(
      'McpTool only supports header-based API key authentication. Configured location: undefined',
    );
  });

  it('refuses an API key with no auth scheme without naming the key', async () => {
    const promise = runAndCollectHeaders({
      authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: API_KEY},
    });

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Cannot find corresponding auth scheme for API key credential.',
    );
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('warns and sends no headers for a service account credential', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const headers = await runAndCollectHeaders({
      authCredential: {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {useDefaultCredential: true},
      },
    });

    expect(headers).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Service account credentials should be exchanged before MCP session creation',
    );
    warnSpy.mockRestore();
  });

  it('sends no headers when no credential is configured', async () => {
    expect(await runAndCollectHeaders({})).toBeUndefined();
  });

  it('returns the pending payload while a credential is unavailable', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Custom-API-Key'},
    });
    const toolContext = createContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({
      pending: true,
      message: 'Needs your authorization to access your data.',
    });
    expect(
      toolContext.eventActions.requestedAuthConfigs['test-function-call-id'],
    ).toBeDefined();
    expect(manager.createSession).not.toHaveBeenCalled();
  });
});

describe('MCPTool dynamic headers', () => {
  it('sends the headers a sync provider returns, resolving it once', async () => {
    const headerProvider = vi.fn().mockReturnValue({'X-Tenant-ID': 'acme'});
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      headerProvider,
    });

    await tool.runAsync({args: {}, toolContext: createContext()});

    expect(sessionHeaders(manager)).toEqual({'X-Tenant-ID': 'acme'});
    expect(headerProvider).toHaveBeenCalledTimes(1);
  });

  it('awaits an async provider', async () => {
    const headers = await runAndCollectHeaders({
      headerProvider: async () => ({'X-Tenant-ID': 'acme'}),
    });

    expect(headers).toEqual({'X-Tenant-ID': 'acme'});
  });

  it('lets a provider header win over an auth header', async () => {
    const headers = await runAndCollectHeaders({
      authScheme: OAUTH2_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'test_token'},
      },
      headerProvider: () => ({
        'Authorization': 'Bearer override',
        'X-Tenant-ID': 'acme',
      }),
    });

    expect(headers).toEqual({
      'Authorization': 'Bearer override',
      'X-Tenant-ID': 'acme',
    });
  });
});

describe('MCPTool confirmation gate', () => {
  it('asks for confirmation and does not open a session', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      requireConfirmation: true,
    });
    const toolContext = createContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(
      toolContext.eventActions.requestedToolConfirmations[
        'test-function-call-id'
      ],
    ).toBeDefined();
    expect(manager.createSession).not.toHaveBeenCalled();
  });

  it('reports a rejected call without opening a session', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      requireConfirmation: true,
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createContext({
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      }),
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(manager.createSession).not.toHaveBeenCalled();
  });

  it('runs the remote call once confirmed', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      requireConfirmation: true,
    });

    await tool.runAsync({
      args: {},
      toolContext: createContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      }),
    });

    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('gates on a predicate and passes it the args and the context', async () => {
    const requireConfirmation = vi.fn().mockReturnValue(true);
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      requireConfirmation,
    });
    const toolContext = createContext();

    const result = await tool.runAsync({args: {force: true}, toolContext});

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(requireConfirmation).toHaveBeenCalledWith(
      {force: true},
      toolContext,
    );
  });

  it('runs the remote call when the predicate declines to gate', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      requireConfirmation: async (args) => args['force'] === true,
    });

    await tool.runAsync({args: {force: false}, toolContext: createContext()});

    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('reports the gate to the resume path', async () => {
    const manager = createSessionManager(createClient());
    const toolContext = createContext();
    const flagged = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      requireConfirmation: true,
    });
    const predicated = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      requireConfirmation: (args) => args['force'] === true,
    });
    const ungated = new MCPTool(TOOL_DEFINITION, manager);

    expect(await flagged.checkRequireConfirmation({}, toolContext)).toBe(true);
    expect(
      await predicated.checkRequireConfirmation({force: true}, toolContext),
    ).toBe(true);
    expect(
      await predicated.checkRequireConfirmation({force: false}, toolContext),
    ).toBe(false);
    expect(await ungated.checkRequireConfirmation({}, toolContext)).toBe(false);
  });

  it('refuses to evaluate a predicate without a tool context', async () => {
    const manager = createSessionManager(createClient());
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      requireConfirmation: () => true,
    });

    await expect(tool.checkRequireConfirmation({})).rejects.toThrow(
      "Tool 'test-tool' requires confirmation but no tool context was provided.",
    );
  });
});

describe('MCPTool progress notifications', () => {
  it('forwards a progress notification to the callback', async () => {
    const received: Progress[] = [];
    const client = createClient();
    vi.mocked(client.callTool).mockImplementation(
      async (_params, _schema, options) => {
        options?.onprogress?.({progress: 1, total: 2, message: 'half'});
        return {content: []};
      },
    );
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      progressCallback: (progress) => {
        received.push(progress);
      },
    });

    await tool.runAsync({args: {}, toolContext: createContext()});

    expect(received).toEqual([{progress: 1, total: 2, message: 'half'}]);
  });

  it('builds a callback per invocation from the factory', async () => {
    const received: Progress[] = [];
    const callback: McpProgressCallback = (progress) => {
      received.push(progress);
    };
    const progressCallbackFactory = vi.fn().mockReturnValue(callback);
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      progressCallbackFactory,
    });
    const toolContext = createContext();

    await tool.runAsync({args: {}, toolContext});

    expect(progressCallbackFactory).toHaveBeenCalledTimes(1);
    expect(progressCallbackFactory).toHaveBeenCalledWith('test-tool', {
      callbackContext: toolContext,
    });
    // The factory's callback reaches the SDK through the adapter, so it is
    // identified by what it receives rather than by identity.
    callOptions(client)?.onprogress?.({progress: 1, total: 2});
    await Promise.resolve();
    expect(received).toEqual([{progress: 1, total: 2}]);
  });

  it('sends no onprogress when the factory returns nothing', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager, undefined, {
      progressCallbackFactory: () => undefined,
    });

    await tool.runAsync({args: {}, toolContext: createContext()});

    expect(callOptions(client)?.onprogress).toBeUndefined();
  });

  it('refuses both a callback and a factory', () => {
    const manager = createSessionManager(createClient());

    expect(
      () =>
        new MCPTool(TOOL_DEFINITION, manager, undefined, {
          progressCallback: () => {},
          progressCallbackFactory: () => undefined,
        }),
    ).toThrow(
      'Configure either progressCallback or progressCallbackFactory, not both.',
    );
  });
});

describe('MCPTool session setup retry', () => {
  throwOnFailure();

  it('retries session setup once and calls the tool once', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    vi.mocked(manager.createSession)
      .mockRejectedValueOnce(new Error('Failed to create MCP session: boom'))
      .mockResolvedValue(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager);

    await tool.runAsync({args: {}, toolContext: createContext()});

    expect(manager.createSession).toHaveBeenCalledTimes(2);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('gives up after a second setup failure', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    vi.mocked(manager.createSession).mockRejectedValue(
      new Error('Failed to create MCP session: boom'),
    );
    const tool = new MCPTool(TOOL_DEFINITION, manager);

    await expect(
      tool.runAsync({args: {}, toolContext: createContext()}),
    ).rejects.toThrow('Failed to create MCP session: boom');
    expect(manager.createSession).toHaveBeenCalledTimes(2);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('does not retry setup for an aborted call', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    vi.mocked(manager.createSession).mockRejectedValue(new Error('boom'));
    const controller = new AbortController();
    controller.abort();
    const tool = new MCPTool(TOOL_DEFINITION, manager);

    await expect(
      tool.runAsync({
        args: {},
        toolContext: createContext({signal: controller.signal}),
      }),
    ).rejects.toThrow('boom');
    expect(manager.createSession).toHaveBeenCalledTimes(1);
  });

  it('never repeats a remote call that failed', async () => {
    const client = createClient();
    vi.mocked(client.callTool).mockRejectedValue(new Error('tool exploded'));
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager);

    await expect(
      tool.runAsync({args: {}, toolContext: createContext()}),
    ).rejects.toThrow('tool exploded');
    expect(manager.createSession).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('never repeats a remote call that failed after the response', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    vi.mocked(manager.closeSession).mockRejectedValue(
      new Error('close blew up'),
    );
    const tool = new MCPTool(TOOL_DEFINITION, manager);

    await expect(
      tool.runAsync({args: {}, toolContext: createContext()}),
    ).rejects.toThrow('close blew up');
    expect(manager.createSession).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });
});

describe('MCPTool transport crash', () => {
  throwOnFailure();

  it('fails the call when the transport errors under it', async () => {
    const previousOnError = vi.fn();
    const client = createClient();
    client.onerror = previousOnError;
    vi.mocked(client.callTool).mockReturnValue(new Promise(() => {}));
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager);

    const promise = tool.runAsync({args: {}, toolContext: createContext()});
    await vi.waitFor(() => {
      expect(client.callTool).toHaveBeenCalled();
    });
    const crash = new Error('transport blew up');
    client.onerror?.(crash);

    await expect(promise).rejects.toThrow('transport blew up');
    expect(previousOnError).toHaveBeenCalledWith(crash);
    expect(client.onerror).toBe(previousOnError);
  });

  it('fails the call when the transport closes under it', async () => {
    const previousOnClose = vi.fn();
    const client = createClient();
    client.onclose = previousOnClose;
    vi.mocked(client.callTool).mockReturnValue(new Promise(() => {}));
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager);

    const promise = tool.runAsync({args: {}, toolContext: createContext()});
    await vi.waitFor(() => {
      expect(client.callTool).toHaveBeenCalled();
    });
    client.onclose?.();

    await expect(promise).rejects.toThrow(
      'MCP transport closed while the tool call was in flight.',
    );
    expect(previousOnClose).toHaveBeenCalled();
    expect(client.onclose).toBe(previousOnClose);
  });
});

describe('MCPTool without options', () => {
  it('calls the tool exactly as it did before the options existed', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    const tool = new MCPTool(TOOL_DEFINITION, manager);
    const controller = new AbortController();

    await tool.runAsync({
      args: {},
      toolContext: createContext({signal: controller.signal}),
    });

    expect(client.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: controller.signal},
    );
    expect(sessionHeaders(manager)).toBeUndefined();
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
  throwOnFailure();

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
  throwOnFailure();

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
  throwOnFailure();

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
