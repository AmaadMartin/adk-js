/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  BaseAuthenticatedTool,
  BaseAuthenticatedToolParams,
  Context,
  InMemoryCredentialService,
  InvocationContext,
  LlmAgent,
  PENDING_AUTH_RESPONSE,
  PluginManager,
  RunAsyncAuthenticatedToolRequest,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CREDENTIAL_KEY = 'test-credential-key';
const FUNCTION_CALL_ID = 'fc-1';

const apiKeyScheme: AuthScheme = {
  type: 'apiKey',
  name: 'X-Api-Key',
  in: 'header',
};

const authorizationCodeScheme: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://oauth.example.com/auth',
      tokenUrl: 'https://oauth.example.com/token',
      scopes: {},
    },
  },
};

const apiKeyAuthConfig: AuthConfig = {
  credentialKey: CREDENTIAL_KEY,
  authScheme: apiKeyScheme,
};

const storedCredential: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'client-supplied-api-key',
};

/**
 * A concrete tool that records every call to the tool body, so a test can
 * assert both what the body received and whether it ran at all.
 */
class RecordingAuthenticatedTool extends BaseAuthenticatedTool {
  readonly calls: RunAsyncAuthenticatedToolRequest[] = [];

  constructor(
    params: Partial<BaseAuthenticatedToolParams> = {},
    private readonly body: (
      req: RunAsyncAuthenticatedToolRequest,
    ) => unknown = () => 'test_result',
  ) {
    super({
      name: 'test_auth_tool',
      description: 'Test authenticated tool',
      ...params,
    });
  }

  protected override async runAsyncImpl(
    req: RunAsyncAuthenticatedToolRequest,
  ): Promise<unknown> {
    this.calls.push(req);
    return this.body(req);
  }
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
      credentialService: new InMemoryCredentialService(),
    }),
    functionCallId: FUNCTION_CALL_ID,
  });
}

describe('BaseAuthenticatedTool', () => {
  it('runs the tool body without a credential when no auth config is set', async () => {
    const tool = new RecordingAuthenticatedTool();
    const toolContext = createToolContext();
    const args = {param1: 'value1'};

    const result = await tool.runAsync({args, toolContext});

    expect(result).toBe('test_result');
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0].args).toEqual(args);
    expect(tool.calls[0].toolContext).toBe(toolContext);
    expect(tool.calls[0].credential).toBeUndefined();
  });

  it('passes complex args through to the tool body unchanged', async () => {
    const tool = new RecordingAuthenticatedTool();
    const complexArgs = {
      stringParam: 'test',
      numberParam: 42,
      listParam: [1, 2, 3],
      objectParam: {nested: 'value'},
    };

    await tool.runAsync({args: {}, toolContext: createToolContext()});
    await tool.runAsync({
      args: complexArgs,
      toolContext: createToolContext(),
    });

    expect(tool.calls[0].args).toEqual({});
    expect(tool.calls[1].args).toEqual(complexArgs);
  });

  it('runs the tool body with the resolved credential', async () => {
    const tool = new RecordingAuthenticatedTool({
      authConfig: apiKeyAuthConfig,
    });
    const toolContext = createToolContext();
    toolContext.state.set(`temp:${CREDENTIAL_KEY}`, storedCredential);

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe('test_result');
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0].credential).toEqual(storedCredential);
  });

  it('requests a credential and does not run the tool body when none is available', async () => {
    const tool = new RecordingAuthenticatedTool({
      authConfig: apiKeyAuthConfig,
    });
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe('Pending User Authorization.');
    expect(result).toBe(PENDING_AUTH_RESPONSE);
    expect(tool.calls).toHaveLength(0);
    expect(
      toolContext.eventActions.requestedAuthConfigs[FUNCTION_CALL_ID],
    ).toEqual(apiKeyAuthConfig);
  });

  it('returns an object responseForAuthRequired verbatim', async () => {
    const responseForAuthRequired = {
      status: 'authentication_required',
      message: 'Please login',
    };
    const tool = new RecordingAuthenticatedTool({
      authConfig: apiKeyAuthConfig,
      responseForAuthRequired,
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toBe(responseForAuthRequired);
    expect(tool.calls).toHaveLength(0);
  });

  it('returns a string responseForAuthRequired verbatim', async () => {
    const tool = new RecordingAuthenticatedTool({
      authConfig: apiKeyAuthConfig,
      responseForAuthRequired: 'Custom authentication required message',
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toBe('Custom authentication required message');
    expect(tool.calls).toHaveLength(0);
  });

  it('propagates an error thrown by the tool body', async () => {
    const tool = new RecordingAuthenticatedTool({}, () => {
      throw new Error('Implementation failed');
    });

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow('Implementation failed');
  });

  it('propagates a credential resolution error without running the tool body', async () => {
    const tool = new RecordingAuthenticatedTool({
      authConfig: {
        credentialKey: CREDENTIAL_KEY,
        authScheme: authorizationCodeScheme,
      },
    });

    await expect(
      tool.runAsync({args: {}, toolContext: createToolContext()}),
    ).rejects.toThrow('rawAuthCredential is required for auth scheme type');
    expect(tool.calls).toHaveLength(0);
  });

  it.each([
    ['undefined', undefined],
    ['an object', {key: 'value'}],
    ['an array', [1, 2, 3]],
  ])('returns %s from the tool body unchanged', async (_name, returnValue) => {
    const tool = new RecordingAuthenticatedTool({}, () => returnValue);

    const result = await tool.runAsync({
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toEqual(returnValue);
  });

  it('runs the tool body once the client has supplied the credential', async () => {
    const tool = new RecordingAuthenticatedTool({
      authConfig: apiKeyAuthConfig,
    });
    const toolContext = createToolContext();

    const firstResult = await tool.runAsync({args: {}, toolContext});
    expect(firstResult).toBe(PENDING_AUTH_RESPONSE);
    expect(tool.calls).toHaveLength(0);

    // What the framework does with the client's auth response.
    toolContext.state.set(`temp:${CREDENTIAL_KEY}`, storedCredential);
    const secondResult = await tool.runAsync({args: {}, toolContext});

    expect(secondResult).toBe('test_result');
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0].credential).toEqual(storedCredential);
  });
});
