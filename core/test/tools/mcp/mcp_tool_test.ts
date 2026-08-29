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
  InvocationContext,
  McpProgressCallback,
  MCPSessionManager,
  MCPTool,
  McpToolOptions,
  PluginManager,
  ToolConfirmation,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Progress, Tool} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it, vi} from 'vitest';
// The logger singleton is internal (not part of the public API), so it is
// imported via a relative path to spy on the exact instance the tool uses.
import {logger} from '../../../src/utils/logger.js';

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
        `API key authentication is only supported in a header. Configured location: ${location}`,
      );
    },
  );

  it('refuses an API key configured under a non-apiKey scheme', async () => {
    const promise = runAndCollectHeaders({
      authScheme: {type: 'http', scheme: 'bearer'},
      authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: API_KEY},
    });

    await expect(promise).rejects.toThrow(
      'API key authentication is only supported in a header. Configured location: undefined',
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
      'Service account credentials should be exchanged before use as a request header',
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
    const callback: McpProgressCallback = () => {};
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
    expect(callOptions(client)?.onprogress).toBe(callback);
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

describe('MCPTool session lifecycle', () => {
  it('opens one session per call and never retries setup', async () => {
    const client = createClient();
    const manager = createSessionManager(client);
    vi.mocked(manager.createSession).mockRejectedValue(
      new Error('Failed to create MCP session: boom'),
    );
    const tool = new MCPTool(TOOL_DEFINITION, manager);

    await expect(
      tool.runAsync({args: {}, toolContext: createContext()}),
    ).rejects.toThrow('Failed to create MCP session: boom');
    expect(manager.createSession).toHaveBeenCalledTimes(1);
    expect(client.callTool).not.toHaveBeenCalled();
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
});
