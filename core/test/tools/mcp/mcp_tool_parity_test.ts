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

  it('refuses both a progress callback and a progress factory', () => {
    const sessionManager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'unused'},
    });

    expect(
      () =>
        new MCPTool(MCP_TOOL, sessionManager, undefined, {
          progressCallback: () => {},
          progressCallbackFactory: () => undefined,
        }),
    ).toThrow('Supply either progressCallback or progressCallbackFactory');
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

describe('MCPTool confirmation gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for approval on the first gated call', async () => {
    const harness = buildHarness({requireConfirmation: true});
    const requestConfirmation = vi.spyOn(
      harness.toolContext,
      'requestConfirmation',
    );

    const result = await harness.tool.runAsync({
      args: {},
      toolContext: harness.toolContext,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(requestConfirmation).toHaveBeenCalledOnce();
    expect(
      harness.toolContext.actions.requestedToolConfirmations[FUNCTION_CALL_ID],
    ).toBeDefined();
    expect(harness.callTool).not.toHaveBeenCalled();
  });

  it('leaves summarization alone, unlike FunctionTool', async () => {
    const harness = buildHarness({requireConfirmation: true});

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(harness.toolContext.actions.skipSummarization).toBeUndefined();
  });

  it('reports a rejected call without running it', async () => {
    const harness = buildHarness(
      {requireConfirmation: true},
      {toolConfirmation: new ToolConfirmation({confirmed: false})},
    );

    const result = await harness.tool.runAsync({
      args: {},
      toolContext: harness.toolContext,
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(harness.callTool).not.toHaveBeenCalled();
  });

  it('runs an approved call', async () => {
    const harness = buildHarness(
      {requireConfirmation: true},
      {toolConfirmation: new ToolConfirmation({confirmed: true})},
    );

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(harness.callTool).toHaveBeenCalledOnce();
  });

  it('gates on what a predicate answers for the arguments', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const harness = buildHarness({
      requireConfirmation: (args) => {
        seen.push(args);
        return args['path'] !== undefined;
      },
    });

    const ungated = await harness.tool.runAsync({
      args: {other: 1},
      toolContext: harness.toolContext,
    });
    const gated = await harness.tool.runAsync({
      args: {path: '/tmp/x'},
      toolContext: harness.toolContext,
    });

    expect(seen).toEqual([{other: 1}, {path: '/tmp/x'}]);
    expect(ungated).toEqual({content: []});
    expect(gated).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
  });

  it('hands the predicate the tool context', async () => {
    const seen: unknown[] = [];
    const harness = buildHarness({
      requireConfirmation: (_args, toolContext) => {
        seen.push(toolContext);
        return false;
      },
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(seen).toEqual([harness.toolContext]);
  });

  it('awaits an asynchronous predicate', async () => {
    const harness = buildHarness({requireConfirmation: async () => true});

    const result = await harness.tool.runAsync({
      args: {},
      toolContext: harness.toolContext,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
  });

  it('answers checkRequireConfirmation the same way the gate does', async () => {
    const gated = buildHarness({requireConfirmation: true});
    const ungated = buildHarness();
    const byPredicate = buildHarness({
      requireConfirmation: (args) => args['path'] !== undefined,
    });

    await expect(gated.tool.checkRequireConfirmation({})).resolves.toBe(true);
    await expect(ungated.tool.checkRequireConfirmation({})).resolves.toBe(
      false,
    );
    await expect(
      byPredicate.tool.checkRequireConfirmation({path: '/tmp/x'}),
    ).resolves.toBe(true);
  });
});

describe('MCPTool progress notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a static callback as onprogress and reports what the server sends', async () => {
    const reported: Progress[] = [];
    const harness = buildHarness({
      progressCallback: (progress) => reported.push(progress),
    });
    harness.callTool.mockImplementation(async (_params, _schema, options) => {
      options?.onprogress?.({progress: 1, total: 2});
      return {content: []};
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(reported).toEqual([{progress: 1, total: 2}]);
  });

  it('builds a callback per invocation from the tool name and context', async () => {
    const factoryCalls: Array<[string, {callbackContext?: Context}]> = [];
    const reported: Progress[] = [];
    const harness = buildHarness({
      progressCallbackFactory: (toolName, options) => {
        factoryCalls.push([toolName, options]);
        return (progress) => reported.push(progress);
      },
    });
    harness.callTool.mockImplementation(async (_params, _schema, options) => {
      options?.onprogress?.({progress: 3});
      return {content: []};
    });

    await harness.tool.runAsync({args: {}, toolContext: harness.toolContext});

    expect(factoryCalls).toEqual([
      ['test-tool', {callbackContext: harness.toolContext}],
    ]);
    expect(reported).toEqual([{progress: 3}]);
  });

  it('sends no onprogress at all when the factory declines', async () => {
    const harness = buildHarness({progressCallbackFactory: () => undefined});

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
