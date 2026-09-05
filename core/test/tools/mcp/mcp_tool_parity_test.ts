/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Context,
  InvocationContext,
  MCPSessionManager,
  MCPTool,
  McpToolOptions,
  PluginManager,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {Progress, Tool} from '@modelcontextprotocol/sdk/types.js';
import {
  Context as OtelContext,
  TextMapPropagator,
  TextMapSetter,
  propagation,
} from '@opentelemetry/api';
import {MockInstance, afterEach, describe, expect, it, vi} from 'vitest';

const MCP_TOOL: Tool = {
  name: 'test-tool',
  description: 'A test tool',
  inputSchema: {type: 'object', properties: {}},
};

const FUNCTION_CALL_ID = 'call-1';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
};

const OAUTH2_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {accessToken: 'oauth-token'},
};

/** The header a stub propagator writes, so a trace assertion has a value. */
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

interface Harness {
  tool: MCPTool;
  toolContext: Context;
  createSession: MockInstance<MCPSessionManager['createSession']>;
  closeSession: MockInstance<MCPSessionManager['closeSession']>;
  callTool: MockInstance<Client['callTool']>;
}

/**
 * Builds an `MCPTool` over a real session manager and a real MCP client whose
 * transport calls are stubbed, so no type is widened to reach them.
 */
function buildHarness(
  options?: McpToolOptions,
  contextOptions?: {toolConfirmation?: ToolConfirmation},
): Harness {
  const client = new Client({name: 'test-client', version: '1.0.0'});
  const callTool = vi
    .spyOn(client, 'callTool')
    .mockResolvedValue({content: []});

  const sessionManager = new MCPSessionManager({
    type: 'StdioConnectionParams',
    serverParams: {command: 'unused'},
  });

  return {
    tool: new MCPTool(MCP_TOOL, sessionManager, undefined, options),
    toolContext: new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        session: createSession({id: 'test-session', appName: 'test-app'}),
        pluginManager: new PluginManager(),
        abortSignal: new AbortController().signal,
      }),
      functionCallId: FUNCTION_CALL_ID,
      toolConfirmation: contextOptions?.toolConfirmation,
    }),
    createSession: vi
      .spyOn(sessionManager, 'createSession')
      .mockResolvedValue(client),
    closeSession: vi
      .spyOn(sessionManager, 'closeSession')
      .mockResolvedValue(undefined),
    callTool,
  };
}

/** Reads the headers the tool handed to `createSession`. */
function headersPassedToSession(
  harness: Harness,
): Record<string, string> | undefined {
  const [firstCall] = harness.createSession.mock.calls;
  return firstCall?.[0]?.headers;
}

/** A propagator that always writes one `traceparent` entry. */
const STUB_PROPAGATOR: TextMapPropagator = {
  inject(_context: OtelContext, carrier: unknown, setter: TextMapSetter) {
    setter.set(carrier, 'traceparent', TRACEPARENT);
  },
  extract: (context: OtelContext) => context,
  fields: () => ['traceparent'],
};

describe('MCPTool construction', () => {
  it.each([
    'adk_request_credential',
    'adk_request_confirmation',
    'adk_request_input',
    'transfer_to_agent',
  ])('refuses the reserved name %s', (name) => {
    const sessionManager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'unused'},
    });

    expect(() => new MCPTool({...MCP_TOOL, name}, sessionManager)).toThrow(
      `MCP tool name '${name}' collides with a reserved ADK tool name.`,
    );
  });

  it('allows a name that merely starts with a reserved one', () => {
    const sessionManager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'unused'},
    });

    const tool = new MCPTool(
      {...MCP_TOOL, name: 'transfer_to_agent_v2'},
      sessionManager,
    );

    expect(tool.name).toBe('transfer_to_agent_v2');
  });

  it('describes a tool that declares no description as an empty string', () => {
    const sessionManager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'unused'},
    });

    const tool = new MCPTool(
      {name: 'no-description', inputSchema: {type: 'object'}},
      sessionManager,
    );

    expect(tool.description).toBe('');
  });
});

describe('MCPTool invocation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends no headers and the plain request when nothing is configured', async () => {
    const harness = buildHarness();

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(headersPassedToSession(harness)).toBeUndefined();
    expect(harness.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: harness.toolContext.abortSignal},
    );
  });

  it('closes the session on the success path', async () => {
    const harness = buildHarness();

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(harness.closeSession).toHaveBeenCalledOnce();
  });

  it('carries an OAuth2 access token to the session', async () => {
    const harness = buildHarness({
      authScheme: {type: 'oauth2', flows: {}},
      authCredential: OAUTH2_CREDENTIAL,
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(headersPassedToSession(harness)).toEqual({
      Authorization: 'Bearer oauth-token',
    });
  });

  it('carries an API key in the header its scheme names', async () => {
    const harness = buildHarness({
      authScheme: API_KEY_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'api-key-value',
      },
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(headersPassedToSession(harness)).toEqual({
      'X-Api-Key': 'api-key-value',
    });
  });

  it('carries the headers a synchronous provider returns', async () => {
    const harness = buildHarness({
      headerProvider: () => ({'X-Tenant-Id': 'tenant-a'}),
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(headersPassedToSession(harness)).toEqual({
      'X-Tenant-Id': 'tenant-a',
    });
  });

  it('awaits an asynchronous provider', async () => {
    const harness = buildHarness({
      headerProvider: async () => ({'X-Tenant-Id': 'tenant-b'}),
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(headersPassedToSession(harness)).toEqual({
      'X-Tenant-Id': 'tenant-b',
    });
  });

  it('hands the provider the tool context', async () => {
    const seen: unknown[] = [];
    const harness = buildHarness({
      headerProvider: (context) => {
        seen.push(context);
        return {};
      },
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(seen).toEqual([harness.toolContext]);
  });

  it('lets the provider win a collision with the auth headers', async () => {
    const harness = buildHarness({
      authScheme: {type: 'oauth2', flows: {}},
      authCredential: OAUTH2_CREDENTIAL,
      headerProvider: () => ({
        Authorization: 'Bearer provider-token',
        'X-Tenant-Id': 'tenant-c',
      }),
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(headersPassedToSession(harness)).toEqual({
      Authorization: 'Bearer provider-token',
      'X-Tenant-Id': 'tenant-c',
    });
  });

  it('reports no headers when the provider returns an empty map', async () => {
    const harness = buildHarness({headerProvider: () => ({})});

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(headersPassedToSession(harness)).toBeUndefined();
  });

  it('asks for authorization instead of opening a session', async () => {
    const harness = buildHarness({authScheme: API_KEY_SCHEME});

    const result = await harness.tool.runAsync({
      args: {},
      toolContext: harness.toolContext,
    });

    expect(result).toBe('Pending User Authorization.');
    expect(harness.createSession).not.toHaveBeenCalled();
  });
});

describe('MCPTool progress notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports what the server sends, and which tool sent it', async () => {
    const reported: Array<[Progress, string, Context]> = [];
    const harness = buildHarness({
      progressCallback: (progress, invocation) =>
        reported.push([
          progress,
          invocation.toolName,
          invocation.callbackContext,
        ]),
    });
    harness.callTool.mockImplementation(async (_params, _schema, options) => {
      options?.onprogress?.({progress: 1, total: 2});
      return {content: []};
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(reported).toEqual([
      [{progress: 1, total: 2}, 'test-tool', harness.toolContext],
    ]);
  });

  it('sends no onprogress at all when no callback is configured', async () => {
    const harness = buildHarness();

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    const [, , options] = harness.callTool.mock.calls[0];
    expect(options).not.toHaveProperty('onprogress');
  });
});

describe('MCPTool trace context', () => {
  afterEach(() => {
    propagation.disable();
    vi.restoreAllMocks();
  });

  it('sends no _meta when the application registered no propagator', async () => {
    propagation.disable();
    const harness = buildHarness();

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    const [params] = harness.callTool.mock.calls[0];
    expect(params).not.toHaveProperty('_meta');
  });

  it('sends the injected carrier as _meta', async () => {
    propagation.setGlobalPropagator(STUB_PROPAGATOR);
    const harness = buildHarness();

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    const [params] = harness.callTool.mock.calls[0];
    expect(params._meta).toEqual({traceparent: TRACEPARENT});
  });
});
