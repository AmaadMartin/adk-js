/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredentialTypes,
  BaseTool,
  BaseToolset,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  createSession,
  getFunctionCalls,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {
  TOOLSET_AUTH_CREDENTIAL_ID_PREFIX,
  TOOLSET_AUTH_PREPROCESSOR,
  resolveToolsetAuth,
} from '../../src/auth/toolset_auth.js';
import {logger} from '../../src/utils/logger.js';

const CREDENTIAL_KEY = 'toolset-credential-key';

function makeAuthConfig(credentialKey = CREDENTIAL_KEY): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'x-api-key'},
    credentialKey,
  };
}

class PlainToolset extends BaseToolset {
  constructor() {
    super([]);
  }
  override async getTools(): Promise<BaseTool[]> {
    return [];
  }
  override async close(): Promise<void> {}
}

class AuthenticatedToolset extends BaseToolset {
  constructor(private readonly authConfig: AuthConfig) {
    super([]);
  }
  override getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }
  override async getTools(): Promise<BaseTool[]> {
    return [];
  }
  override async close(): Promise<void> {}
}

function makeContext(agent: LlmAgent, state: Record<string, unknown> = {}) {
  return new InvocationContext({
    invocationId: 'invocation-id',
    agent,
    session: createSession({
      id: 'session-id',
      appName: 'app',
      userId: 'user',
      state,
    }),
    pluginManager: new PluginManager(),
  });
}

async function collect(
  generator: AsyncGenerator<Event, void, void>,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe('resolveToolsetAuth', () => {
  it('does nothing when the agent has no tools', async () => {
    const agent = new LlmAgent({name: 'agent', model: 'fake-model'});
    const invocationContext = makeContext(agent);

    const events = await collect(resolveToolsetAuth(invocationContext, agent));

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
    expect(invocationContext.credentialByKey).toEqual({});
  });

  it('skips a toolset that declares no auth config', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'fake-model',
      tools: [new PlainToolset()],
    });
    const invocationContext = makeContext(agent);

    const events = await collect(resolveToolsetAuth(invocationContext, agent));

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
    expect(invocationContext.credentialByKey).toEqual({});
  });

  it('skips a tool that is not a toolset', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'fake-model',
      tools: [
        new FunctionTool({
          name: 'plain',
          description: 'A plain tool.',
          execute: async () => 'ok',
        }),
      ],
    });
    const invocationContext = makeContext(agent);

    const events = await collect(resolveToolsetAuth(invocationContext, agent));

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
  });

  it('stores an available credential on the invocation without interrupting', async () => {
    const authConfig = makeAuthConfig();
    const agent = new LlmAgent({
      name: 'agent',
      model: 'fake-model',
      tools: [new AuthenticatedToolset(authConfig)],
    });
    const invocationContext = makeContext(agent, {
      [`temp:${CREDENTIAL_KEY}`]: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-value',
      },
    });

    const events = await collect(resolveToolsetAuth(invocationContext, agent));

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
    expect(invocationContext.credentialByKey[CREDENTIAL_KEY]).toEqual({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-value',
    });
    // The toolset's own config is shared across invocations and stays clean.
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('throws when a resolved config carries no credential key', async () => {
    const authConfig = makeAuthConfig();
    const agent = new LlmAgent({
      name: 'agent',
      model: 'fake-model',
      tools: [new AuthenticatedToolset(authConfig)],
    });
    const invocationContext = makeContext(agent, {
      'temp:': {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-value',
      },
    });
    // A config whose key was dropped still resolves, under the bare prefix.
    authConfig.credentialKey = '';

    await expect(
      collect(resolveToolsetAuth(invocationContext, agent)),
    ).rejects.toThrow('Resolved toolset auth is missing a credential key.');
  });

  it('asks the client for a credential that is not available', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'fake-model',
      tools: [new AuthenticatedToolset(makeAuthConfig())],
    });
    const invocationContext = makeContext(agent);

    const events = await collect(resolveToolsetAuth(invocationContext, agent));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('agent');
    expect(invocationContext.endInvocation).toBe(true);
    expect(invocationContext.credentialByKey).toEqual({});

    const functionCalls = getFunctionCalls(events[0]);
    expect(functionCalls).toHaveLength(1);
    expect(functionCalls[0].name).toBe(REQUEST_CREDENTIAL_FUNCTION_CALL_NAME);
    expect(events[0].longRunningToolIds).toEqual([functionCalls[0].id]);

    const args = functionCalls[0].args as {function_call_id: string};
    expect(args.function_call_id).toBe(
      `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}AuthenticatedToolset`,
    );
  });

  it('asks once when two toolsets of the same class need a credential', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'fake-model',
      tools: [
        new AuthenticatedToolset(makeAuthConfig('first-key')),
        new AuthenticatedToolset(makeAuthConfig('second-key')),
      ],
    });
    const invocationContext = makeContext(agent);

    const events = await collect(resolveToolsetAuth(invocationContext, agent));

    expect(events).toHaveLength(1);
    const functionCalls = getFunctionCalls(events[0]);
    expect(functionCalls).toHaveLength(1);
    // The later toolset wins the shared id, so its config is the one sent.
    const args = functionCalls[0].args as {auth_config: AuthConfig};
    expect(args.auth_config.credentialKey).toBe('second-key');
  });

  it('warns and asks for a credential when the lookup throws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const state = {} as Record<string, unknown>;
    Object.defineProperty(state, `temp:${CREDENTIAL_KEY}`, {
      enumerable: true,
      get() {
        throw new Error('credential store unavailable');
      },
    });
    const agent = new LlmAgent({
      name: 'agent',
      model: 'fake-model',
      tools: [new AuthenticatedToolset(makeAuthConfig())],
    });
    const invocationContext = makeContext(agent, state);

    const events = await collect(resolveToolsetAuth(invocationContext, agent));

    expect(events).toHaveLength(1);
    expect(invocationContext.credentialByKey).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      'Failed to get auth credential for toolset AuthenticatedToolset:',
      expect.any(Error),
    );
    warn.mockRestore();
  });
});

describe('ToolsetAuthPreprocessor', () => {
  it('resolves the toolsets of the agent driving the invocation', async () => {
    const agent = new LlmAgent({
      name: 'agent',
      model: 'fake-model',
      tools: [new AuthenticatedToolset(makeAuthConfig())],
    });
    const invocationContext = makeContext(agent);

    const events = await collect(
      TOOLSET_AUTH_PREPROCESSOR.runAsync(invocationContext),
    );

    expect(events).toHaveLength(1);
    expect(invocationContext.endInvocation).toBe(true);
  });

  it('does nothing when the invocation is running a node rather than an agent', async () => {
    const invocationContext = new InvocationContext({
      invocationId: 'invocation-id',
      session: createSession({
        id: 'session-id',
        appName: 'app',
        userId: 'user',
      }),
      pluginManager: new PluginManager(),
    });

    const events = await collect(
      TOOLSET_AUTH_PREPROCESSOR.runAsync(invocationContext),
    );

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
  });
});

describe('TOOLSET_AUTH_CREDENTIAL_ID_PREFIX', () => {
  it('is the prefix the resume path recognises', () => {
    expect(TOOLSET_AUTH_CREDENTIAL_ID_PREFIX).toBe('_adk_toolset_auth_');
  });
});
