/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  AuthConfig,
  AuthCredentialTypes,
  AuthScheme,
  BaseTool,
  BaseToolset,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SequentialAgent,
  TOOLSET_AUTH_CREDENTIAL_ID_PREFIX,
  TOOLSET_AUTH_PREPROCESSOR,
  ToolUnion,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {REQUEST_EUC_FUNCTION_CALL_NAME} from '../../src/agents/functions.js';

const OAUTH2_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/authorize',
      tokenUrl: 'https://example.com/token',
      scopes: {'https://example.com/scope': 'a scope'},
    },
  },
};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-Api-Key',
  in: 'header',
};

/** An OAuth2 config whose raw credential is only a client id and secret. */
function oauth2Config(credentialKey: string): AuthConfig {
  return {
    credentialKey,
    authScheme: OAUTH2_SCHEME,
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'test-client-id', clientSecret: 'test-client-secret'},
    },
  };
}

class StubTool extends BaseTool {
  constructor(name: string) {
    super({name, description: 'A stub tool.'});
  }

  async runAsync(): Promise<unknown> {
    return 'stub';
  }
}

class StubToolset extends BaseToolset {
  getToolsCallCount = 0;

  constructor(private readonly authConfig?: AuthConfig) {
    super([]);
  }

  override getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  override async getTools(): Promise<BaseTool[]> {
    this.getToolsCallCount++;
    return [new StubTool('stub_tool')];
  }

  override async close(): Promise<void> {}
}

function createContext(
  tools: ToolUnion[],
  state: Record<string, unknown> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_1',
    agent: new LlmAgent({name: 'test_agent', tools}),
    session: createSession({id: 'sess_1', appName: 'test_app', state}),
    pluginManager: new PluginManager(),
  });
}

async function collect(invocationContext: InvocationContext): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of TOOLSET_AUTH_PREPROCESSOR.runAsync(
    invocationContext,
  )) {
    events.push(event);
  }
  return events;
}

function functionCalls(event: Event): FunctionCall[] {
  return (event.content?.parts ?? [])
    .map((part) => part.functionCall)
    .filter((call): call is FunctionCall => call !== undefined);
}

describe('ToolsetAuthPreprocessor', () => {
  it('yields nothing when the agent is not an LlmAgent', async () => {
    const invocationContext = new InvocationContext({
      invocationId: 'inv_1',
      agent: new SequentialAgent({name: 'plain_agent'}),
      session: createSession({id: 'sess_1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    });

    expect(await collect(invocationContext)).toHaveLength(0);
    expect(invocationContext.endInvocation).toBe(false);
  });

  it('yields nothing when the agent has no tools', async () => {
    const invocationContext = createContext([]);

    expect(await collect(invocationContext)).toHaveLength(0);
    expect(invocationContext.endInvocation).toBe(false);
  });

  it('yields nothing when the agent holds only plain tools', async () => {
    const invocationContext = createContext([new StubTool('plain_tool')]);

    expect(await collect(invocationContext)).toHaveLength(0);
    expect(invocationContext.endInvocation).toBe(false);
  });

  it('yields nothing when the toolset declares no auth config', async () => {
    const invocationContext = createContext([new StubToolset()]);

    expect(await collect(invocationContext)).toHaveLength(0);
    expect(invocationContext.endInvocation).toBe(false);
  });

  it('yields nothing when the credential is already in the session state', async () => {
    const invocationContext = createContext(
      [new StubToolset(oauth2Config('catalog_key'))],
      {
        'temp:catalog_key': {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {accessToken: 'stored-token'},
        },
      },
    );

    expect(await collect(invocationContext)).toHaveLength(0);
    expect(invocationContext.endInvocation).toBe(false);
  });

  it('yields nothing for a non-exchangeable scheme with a raw credential', async () => {
    const invocationContext = createContext([
      new StubToolset({
        credentialKey: 'api_key',
        authScheme: API_KEY_SCHEME,
        rawAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'developer-supplied-key',
        },
      }),
    ]);

    expect(await collect(invocationContext)).toHaveLength(0);
    expect(invocationContext.endInvocation).toBe(false);
  });

  it('requests a credential for a pending OAuth2 toolset and interrupts the turn', async () => {
    const invocationContext = createContext([
      new StubToolset(oauth2Config('catalog_key')),
    ]);

    const events = await collect(invocationContext);

    expect(events).toHaveLength(1);
    expect(invocationContext.endInvocation).toBe(true);

    const event = events[0];
    expect(event.invocationId).toBe('inv_1');
    expect(event.author).toBe('test_agent');
    expect(event.content?.role).toBeUndefined();

    const calls = functionCalls(event);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(REQUEST_EUC_FUNCTION_CALL_NAME);
    expect(calls[0].args?.['function_call_id']).toBe(
      `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}catalog_key`,
    );
    expect(event.longRunningToolIds).toEqual([calls[0].id]);

    const authConfig = calls[0].args?.['auth_config'] as AuthConfig;
    expect(authConfig.credentialKey).toBe('catalog_key');
    expect(authConfig.exchangedAuthCredential?.oauth2?.authUri).toContain(
      'https://example.com/authorize',
    );
  });

  it('requests one credential per distinct credential key in a single event', async () => {
    const invocationContext = createContext([
      new StubToolset(oauth2Config('first_key')),
      new StubToolset(oauth2Config('second_key')),
    ]);

    const events = await collect(invocationContext);

    expect(events).toHaveLength(1);
    const calls = functionCalls(events[0]);
    expect(calls.map((call) => call.args?.['function_call_id'])).toEqual([
      `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}first_key`,
      `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}second_key`,
    ]);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    expect(events[0].longRunningToolIds).toEqual(calls.map((call) => call.id));
  });

  it('collapses two toolsets that share a credential key into one request', async () => {
    const invocationContext = createContext([
      new StubToolset(oauth2Config('shared_key')),
      new StubToolset(oauth2Config('shared_key')),
    ]);

    const events = await collect(invocationContext);

    expect(events).toHaveLength(1);
    expect(functionCalls(events[0])).toHaveLength(1);
  });

  it('requests a credential only for the pending toolset', async () => {
    const invocationContext = createContext(
      [
        new StubToolset(oauth2Config('satisfied_key')),
        new StubToolset(oauth2Config('pending_key')),
      ],
      {
        'temp:satisfied_key': {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {accessToken: 'stored-token'},
        },
      },
    );

    const events = await collect(invocationContext);

    const calls = functionCalls(events[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args?.['function_call_id']).toBe(
      `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}pending_key`,
    );
  });

  it('skips a toolset whose auth request throws and still serves the others', async () => {
    const misconfigured: AuthConfig = {
      credentialKey: 'misconfigured_key',
      authScheme: OAUTH2_SCHEME,
    };
    const invocationContext = createContext([
      new StubToolset(misconfigured),
      new StubToolset(oauth2Config('healthy_key')),
    ]);

    const events = await collect(invocationContext);

    expect(events).toHaveLength(1);
    const calls = functionCalls(events[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args?.['function_call_id']).toBe(
      `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}healthy_key`,
    );
  });

  it('yields nothing when every toolset auth request throws', async () => {
    const invocationContext = createContext([
      new StubToolset({
        credentialKey: 'misconfigured_key',
        authScheme: OAUTH2_SCHEME,
      }),
    ]);

    expect(await collect(invocationContext)).toHaveLength(0);
    expect(invocationContext.endInvocation).toBe(false);
  });

  it('does not mutate the auth config owned by the toolset', async () => {
    const authConfig = oauth2Config('catalog_key');
    const snapshot = structuredClone(authConfig);
    const invocationContext = createContext([new StubToolset(authConfig)]);

    await collect(invocationContext);

    expect(authConfig).toEqual(snapshot);
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('emits an id that AuthPreprocessor does not resume as a tool call', async () => {
    expect(TOOLSET_AUTH_CREDENTIAL_ID_PREFIX).toBe('_adk_toolset_auth_');

    const toolset = new StubToolset(oauth2Config('catalog_key'));
    const invocationContext = createContext([toolset]);
    const requestEvent = (await collect(invocationContext))[0];
    const requestCall = functionCalls(requestEvent)[0];
    const syntheticId = requestCall.args?.['function_call_id'] as string;

    const session = invocationContext.session;
    session.events.push(
      // A decoy tool call that carries the synthetic id. AuthPreprocessor
      // resumes it only if the prefix check fails to skip the id.
      createEvent({
        author: 'test_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: syntheticId, name: 'stub_tool'}}],
        },
      }),
      createEvent({
        author: 'test_agent',
        content: {role: 'model', parts: [{functionCall: requestCall}]},
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: requestCall.id,
                name: REQUEST_EUC_FUNCTION_CALL_NAME,
                response: {
                  ...(requestCall.args?.['auth_config'] as AuthConfig),
                  exchangedAuthCredential: {
                    authType: AuthCredentialTypes.OAUTH2,
                    oauth2: {accessToken: 'exchanged-token'},
                  },
                },
              },
            },
          ],
        },
      }),
    );

    const resumeEvents: Event[] = [];
    for await (const event of AUTH_PREPROCESSOR.runAsync(invocationContext)) {
      resumeEvents.push(event);
    }

    expect(resumeEvents).toHaveLength(0);
    expect(toolset.getToolsCallCount).toBe(0);
    expect(session.state['temp:catalog_key']).toEqual({
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'exchanged-token'},
    });

    invocationContext.endInvocation = false;
    expect(await collect(invocationContext)).toHaveLength(0);
    expect(invocationContext.endInvocation).toBe(false);
  });
});
