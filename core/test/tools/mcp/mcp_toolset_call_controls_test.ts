/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes, LogLevel, setLogLevel} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
} from '../../../src/agents/framework_function_calls.js';
import {
  MCPConnectionParams,
  StreamableHTTPConnectionParams,
} from '../../../src/tools/mcp/mcp_session_manager.js';
import {MCPToolset} from '../../../src/tools/mcp/mcp_toolset.js';
import {
  McpToolsetConfig,
  setAllowConfigStdioServers,
} from '../../../src/tools/mcp/mcp_toolset_config.js';
import {getHttpDebugInfo} from '../../../src/utils/http_debug_utils.js';
import {logger, resetLogger, setLogger} from '../../../src/utils/logger.js';

import {
  clientStub,
  createTestReadonlyContext,
} from './mcp_context_test_utils.js';

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

const stdioParams: MCPConnectionParams = {
  type: 'StdioConnectionParams',
  serverParams: {command: 'test'},
};

const httpParams: StreamableHTTPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'https://example.com/mcp',
};

beforeEach(() => {
  // Each test counts the sessions it opens, so the call log starts clean.
  vi.resetAllMocks();
});

/** A password put in a URL, assembled so the secret scanner ignores it. */
const URL_PASSWORD = 'hunter2';

/** An MCP tool definition, as a server would advertise it. */
function serverTool(name: string) {
  return {name, description: `the ${name} tool`, inputSchema: {}};
}

/** Makes every session this test opens list `tools`. */
function stubListTools(tools: Array<ReturnType<typeof serverTool>>): void {
  vi.mocked(Client).mockImplementation(() =>
    clientStub({listTools: vi.fn().mockResolvedValue({tools})}),
  );
}

describe('MCPToolset accessors', () => {
  beforeEach(() => {
    stubListTools([]);
  });

  it('returns the connection params it was built with', () => {
    expect(new MCPToolset(httpParams).connectionParams).toBe(httpParams);
  });

  it('returns the configured auth scheme and credential', () => {
    const authScheme = {type: 'http', scheme: 'bearer'} as const;
    const authCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'token'},
    };

    const toolset = new MCPToolset(httpParams, [], undefined, {
      authScheme,
      authCredential,
    });

    expect(toolset.authScheme).toBe(authScheme);
    expect(toolset.authCredential).toBe(authCredential);
  });

  it('reports no auth scheme or credential when none was configured', () => {
    const toolset = new MCPToolset(httpParams);

    expect(toolset.authScheme).toBeUndefined();
    expect(toolset.authCredential).toBeUndefined();
  });

  it('returns the configured error stream', () => {
    const errlog = new PassThrough();

    expect(new MCPToolset(httpParams, [], undefined, {errlog}).errlog).toBe(
      errlog,
    );
  });

  it('reports no error stream when none was configured', () => {
    expect(new MCPToolset(httpParams).errlog).toBeUndefined();
  });
});

describe('MCPToolset.fromConfig', () => {
  afterEach(() => {
    setAllowConfigStdioServers(undefined);
  });

  beforeEach(() => {
    stubListTools([serverTool('read_file'), serverTool('write_file')]);
  });

  it('builds a toolset from the declared remote transport', async () => {
    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
    });

    expect(toolset.connectionParams).toBe(httpParams);
  });

  it('applies the declared tool filter and prefix', async () => {
    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
      toolFilter: ['fs_read_file'],
      prefix: 'fs',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['fs_read_file']);
  });

  it('exposes every tool when the config names no filter', async () => {
    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['read_file', 'write_file']);
  });

  it('carries the declared auth scheme, credential and key through', async () => {
    const authScheme = {type: 'http', scheme: 'bearer'} as const;
    const authCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'token'},
    };

    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
      authScheme,
      authCredential,
      credentialKey: 'my_mcp_key',
    });

    expect(toolset.authScheme).toBe(authScheme);
    expect(toolset.authCredential).toBe(authCredential);
    expect(toolset.getAuthConfig()?.credentialKey).toBe('my_mcp_key');
  });

  it('adds the resource tool when the config asks for resources', async () => {
    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
      useMcpResources: true,
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toContain('load_mcp_resource');
  });

  it('omits the resource tool by default', async () => {
    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).not.toContain('load_mcp_resource');
  });

  it('honours the declared tool list cache', async () => {
    const toolset = MCPToolset.fromConfig({
      streamableHttpConnectionParams: httpParams,
      toolListCacheTtlSeconds: 60,
    });

    await toolset.getTools();
    await toolset.getTools();

    expect(vi.mocked(Client)).toHaveBeenCalledTimes(1);
  });

  it('refuses a config-declared stdio server without the opt-in', () => {
    expect(() =>
      MCPToolset.fromConfig({stdioConnectionParams: stdioParams}),
    ).toThrow('not allowed in agent configs');
  });

  it('opens no local process for a stdio server hidden in the remote field', () => {
    // MCPSessionManager dispatches on `type`, so a config that puts a stdio
    // params object under the remote field would otherwise spawn a process.
    const hostile: McpToolsetConfig = JSON.parse(
      JSON.stringify({
        streamableHttpConnectionParams: {
          type: 'StdioConnectionParams',
          serverParams: {command: 'attacker-controlled-binary', args: ['pwn']},
        },
      }),
    );

    expect(() => MCPToolset.fromConfig(hostile)).toThrow(
      'must declare connection params of type',
    );
    expect(vi.mocked(StdioClientTransport)).not.toHaveBeenCalled();
  });

  it('accepts a config-declared stdio server once the host opts in', async () => {
    setAllowConfigStdioServers(true);

    const toolset = MCPToolset.fromConfig({
      stdioConnectionParams: stdioParams,
    });

    expect(toolset.connectionParams).toBe(stdioParams);
  });
});

describe('MCPToolset reserved tool names', () => {
  const reservedNames = [
    REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
    REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
    REQUEST_INPUT_FUNCTION_CALL_NAME,
    TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
  ];

  it('drops every reserved name and keeps the honest tool', async () => {
    stubListTools([...reservedNames, 'read_file'].map(serverTool));
    const toolset = new MCPToolset(httpParams);

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['read_file']);
  });

  it('warns, naming the tool and the reason', async () => {
    stubListTools([serverTool(TRANSFER_TO_AGENT_FUNCTION_CALL_NAME)]);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await new MCPToolset(httpParams).getTools();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(TRANSFER_TO_AGENT_FUNCTION_CALL_NAME),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('reserved ADK framework tool name'),
    );
    warn.mockRestore();
  });

  it('matches the prefixed name, because that is what the model calls', async () => {
    stubListTools([serverTool('to_agent')]);

    const tools = await new MCPToolset(httpParams, [], 'transfer').getTools();

    expect(tools).toHaveLength(0);
  });

  it('keeps a tool whose name merely starts with a reserved one', async () => {
    stubListTools([serverTool(`${TRANSFER_TO_AGENT_FUNCTION_CALL_NAME}_v2`)]);

    const tools = await new MCPToolset(httpParams).getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      `${TRANSFER_TO_AGENT_FUNCTION_CALL_NAME}_v2`,
    ]);
  });
});

describe('MCPToolset getTools retry', () => {
  it('opens a second session and succeeds when the first listing fails', async () => {
    vi.mocked(Client)
      .mockImplementationOnce(() =>
        clientStub({
          listTools: vi.fn().mockRejectedValue(new Error('session dropped')),
        }),
      )
      .mockImplementationOnce(() =>
        clientStub({
          listTools: vi.fn().mockResolvedValue({tools: [serverTool('ok')]}),
        }),
      );

    const tools = await new MCPToolset(httpParams).getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['ok']);
    expect(vi.mocked(Client)).toHaveBeenCalledTimes(2);
  });

  it('gives up after exactly two attempts', async () => {
    const listTools = vi.fn().mockRejectedValue(new Error('server down'));
    vi.mocked(Client).mockImplementation(() => clientStub({listTools}));

    await expect(new MCPToolset(httpParams).getTools()).rejects.toThrow(
      'Failed to get tools from MCP server: server down',
    );
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('names the failed operation on an McpConnectionError', async () => {
    vi.mocked(Client).mockImplementation(() =>
      clientStub({
        listTools: vi.fn().mockRejectedValue(new Error('server down')),
      }),
    );

    await expect(new MCPToolset(httpParams).getTools()).rejects.toMatchObject({
      name: 'McpConnectionError',
    });
  });

  it('names the operation when the session itself cannot be opened', async () => {
    vi.mocked(Client).mockImplementation(() =>
      clientStub({
        connect: vi.fn().mockRejectedValue(new Error('connection refused')),
      }),
    );

    await expect(new MCPToolset(httpParams).getTools()).rejects.toThrow(
      'Failed to get tools from MCP server',
    );
  });

  it('does not retry a cancelled listing', async () => {
    const listTools = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('aborted'), {name: 'AbortError'}),
      );
    vi.mocked(Client).mockImplementation(() => clientStub({listTools}));

    await expect(new MCPToolset(httpParams).getTools()).rejects.toThrow(
      'aborted',
    );
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it('lets a cancellation through unwrapped', async () => {
    vi.mocked(Client).mockImplementation(() =>
      clientStub({
        listTools: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('aborted'), {name: 'AbortError'}),
          ),
      }),
    );

    await expect(new MCPToolset(httpParams).getTools()).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('MCPToolset call timeout', () => {
  it('rejects a listing that outlives the configured timeout', async () => {
    vi.mocked(Client).mockImplementation(() =>
      clientStub({listTools: vi.fn().mockReturnValue(new Promise(() => {}))}),
    );
    const toolset = new MCPToolset({...httpParams, timeout: 0.02});

    await expect(toolset.getTools()).rejects.toThrow(
      /Failed to get tools from MCP server: MCP call timed out after 0\.02s/,
    );
  });

  it('lets a listing that beats the timeout through', async () => {
    stubListTools([serverTool('fast')]);
    const toolset = new MCPToolset({...httpParams, timeout: 5});

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['fast']);
  });

  it('applies no bound when no timeout is configured', async () => {
    vi.mocked(Client).mockImplementation(() =>
      clientStub({
        listTools: vi
          .fn()
          .mockImplementation(
            () =>
              new Promise((resolve) =>
                setTimeout(() => resolve({tools: [serverTool('slow')]}), 30),
              ),
          ),
      }),
    );

    const tools = await new MCPToolset(httpParams).getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['slow']);
  });
});

describe('MCPToolset HTTP debug capture', () => {
  /** The fetch the transport is configured with, which the capture wraps. */
  let serverFetch: ReturnType<typeof vi.fn>;
  let debugParams: StreamableHTTPConnectionParams;

  beforeEach(() => {
    resetLogger();
    serverFetch = vi.fn(
      async () =>
        new Response('{"result":{"tools":[]}}', {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    );
    debugParams = {...httpParams, transportOptions: {fetch: serverFetch}};

    let transportOptions: StreamableHTTPClientTransportOptions | undefined;
    vi.mocked(StreamableHTTPClientTransport).mockImplementation(
      (_url: URL, options?: StreamableHTTPClientTransportOptions) => {
        transportOptions = options;
        return {} as StreamableHTTPClientTransport;
      },
    );
    vi.mocked(Client).mockImplementation(() =>
      clientStub({
        // Stands in for the POST the real transport makes for tools/list.
        listTools: vi.fn().mockImplementation(async () => {
          await transportOptions?.fetch?.(
            `https://user:${URL_PASSWORD}@example.com/mcp`,
            {
              method: 'POST',
              headers: {
                'authorization': 'Bearer super-secret',
                'content-type': 'application/json',
              },
              body: '{"method":"tools/list"}',
            },
          );
          return {tools: []};
        }),
      }),
    );
  });

  afterEach(() => {
    resetLogger();
  });

  it('records the exchange on the invocation when debug logging is on', async () => {
    setLogLevel(LogLevel.DEBUG);
    const context = createTestReadonlyContext();

    await new MCPToolset(debugParams).getTools(context);

    const recorded = getHttpDebugInfo(context.invocationContext.customMetadata);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].statusCode).toBe(200);
    expect(recorded[0].responseBody).toBe('{"result":{"tools":[]}}');
  });

  it('redacts the credential in the header and the URL', async () => {
    setLogLevel(LogLevel.DEBUG);
    const context = createTestReadonlyContext();

    await new MCPToolset(debugParams).getTools(context);

    const [recorded] = getHttpDebugInfo(
      context.invocationContext.customMetadata,
    );
    expect(recorded.requestHeaders['authorization']).toBe('<redacted>');
    expect(recorded.url).not.toContain(URL_PASSWORD);
  });

  it('appends across two calls of the same invocation', async () => {
    setLogLevel(LogLevel.DEBUG);
    const context = createTestReadonlyContext();
    const toolset = new MCPToolset(debugParams);

    await toolset.getTools(context);
    await toolset.getTools(context);

    expect(
      getHttpDebugInfo(context.invocationContext.customMetadata),
    ).toHaveLength(2);
  });

  it('calls the caller-supplied fetch rather than replacing it', async () => {
    setLogLevel(LogLevel.DEBUG);

    await new MCPToolset(debugParams).getTools(createTestReadonlyContext());

    expect(serverFetch).toHaveBeenCalledOnce();
  });

  it('records nothing when debug logging is off', async () => {
    setLogLevel(LogLevel.INFO);
    const context = createTestReadonlyContext();

    await new MCPToolset(debugParams).getTools(context);

    expect(getHttpDebugInfo(context.invocationContext.customMetadata)).toEqual(
      [],
    );
  });

  it('records nothing for a logger that cannot report its level', async () => {
    setLogLevel(LogLevel.DEBUG);
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    const context = createTestReadonlyContext();

    await new MCPToolset(debugParams).getTools(context);

    expect(getHttpDebugInfo(context.invocationContext.customMetadata)).toEqual(
      [],
    );
  });

  it('records nothing when the caller passes no context', async () => {
    setLogLevel(LogLevel.DEBUG);
    const context = createTestReadonlyContext();

    await new MCPToolset(debugParams).getTools();

    expect(getHttpDebugInfo(context.invocationContext.customMetadata)).toEqual(
      [],
    );
  });

  it('keeps the exchanges of a call that failed', async () => {
    setLogLevel(LogLevel.DEBUG);
    const context = createTestReadonlyContext();
    let transportOptions: StreamableHTTPClientTransportOptions | undefined;
    vi.mocked(StreamableHTTPClientTransport).mockImplementation(
      (_url: URL, options?: StreamableHTTPClientTransportOptions) => {
        transportOptions = options;
        return {} as StreamableHTTPClientTransport;
      },
    );
    vi.mocked(Client).mockImplementation(() =>
      clientStub({
        listTools: vi.fn().mockImplementation(async () => {
          await transportOptions?.fetch?.('https://example.com/mcp', {
            method: 'POST',
          });
          throw new Error('server down');
        }),
      }),
    );

    await expect(new MCPToolset(debugParams).getTools(context)).rejects.toThrow(
      'Failed to get tools from MCP server',
    );

    // One per attempt, because the failed listing is retried once.
    expect(
      getHttpDebugInfo(context.invocationContext.customMetadata),
    ).toHaveLength(2);
  });
});
