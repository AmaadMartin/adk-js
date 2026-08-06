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
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  BaseToolset,
  Event,
  FunctionTool,
  getFunctionCalls,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  ReadonlyContext,
  Runner,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const CREDENTIAL_KEY = 'toolset_credential_key';
const TOOLSET_AUTH_PREFIX = '_adk_toolset_auth_';

const AUTH_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const CLIENT_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'client-supplied-key',
};

const TEXT_RESPONSE: LlmResponse = {
  content: {role: 'model', parts: [{text: 'done'}]},
};

class MockLlm extends BaseLlm {
  callCount = 0;
  lastRequest?: LlmRequest;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'mock-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.lastRequest = request;
    const response = this.responses[this.callCount];
    this.callCount++;
    if (response) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

/**
 * A toolset that can only list its tools with a credential. It records the
 * credential every `getTools` call saw, so a test can assert both whether
 * listing happened and what ADK handed it.
 */
class AuthenticatedToolset extends BaseToolset {
  readonly credentialsSeen: Array<AuthCredential | undefined> = [];

  constructor(private readonly authConfig?: AuthConfig) {
    super([]);
  }

  override getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    this.credentialsSeen.push(context?.getCredential(CREDENTIAL_KEY));
    return [
      new FunctionTool({
        name: 'listed_tool',
        description: 'A tool that only an authenticated listing can return',
        parameters: z.object({}),
        execute: async () => ({result: 'ok'}),
      }),
    ];
  }

  async close(): Promise<void> {}
}

function createAgent(
  toolset: AuthenticatedToolset,
  mockLlm: MockLlm,
): LlmAgent {
  return new LlmAgent({
    name: 'toolset_auth_agent',
    model: mockLlm,
    tools: [toolset],
  });
}

async function createRunner(
  agent: LlmAgent,
): Promise<{runner: Runner; session: Session}> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'test_app',
    userId: 'user_1',
  });
  return {
    runner: new Runner({appName: 'test_app', agent, sessionService}),
    session,
  };
}

async function collectTurn(
  runner: Runner,
  session: Session,
  newMessage: NonNullable<Parameters<Runner['runAsync']>[0]['newMessage']>,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user_1',
    sessionId: session.id,
    newMessage,
  })) {
    events.push(event);
  }
  return events;
}

describe('LlmAgent toolset auth', () => {
  it('asks the client for a credential, then lists tools with it', async () => {
    const toolset = new AuthenticatedToolset({
      credentialKey: CREDENTIAL_KEY,
      authScheme: AUTH_SCHEME,
    });
    const mockLlm = new MockLlm([TEXT_RESPONSE]);
    const {runner, session} = await createRunner(createAgent(toolset, mockLlm));

    const firstTurn = await collectTurn(runner, session, {
      parts: [{text: 'go'}],
    });

    expect(firstTurn).toHaveLength(1);
    const authCalls = getFunctionCalls(firstTurn[0]);
    expect(authCalls).toHaveLength(1);
    expect(authCalls[0].name).toBe('adk_request_credential');
    expect(authCalls[0].args!['function_call_id']).toBe(
      `${TOOLSET_AUTH_PREFIX}${CREDENTIAL_KEY}`,
    );
    // The interrupt must come before any tool listing and before the model.
    expect(toolset.credentialsSeen).toEqual([]);
    expect(mockLlm.callCount).toBe(0);

    const secondTurn = await collectTurn(runner, session, {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'adk_request_credential',
            id: authCalls[0].id,
            response: {
              authScheme: AUTH_SCHEME,
              exchangedAuthCredential: CLIENT_CREDENTIAL,
            },
          },
        },
      ],
    });

    expect(secondTurn).toHaveLength(1);
    expect(secondTurn[0].content!.parts![0].text).toBe('done');
    expect(toolset.credentialsSeen.length).toBeGreaterThan(0);
    for (const credential of toolset.credentialsSeen) {
      expect(credential).toEqual(CLIENT_CREDENTIAL);
    }
    expect(mockLlm.callCount).toBe(1);
    expect(Object.keys(mockLlm.lastRequest!.toolsDict)).toEqual([
      'listed_tool',
    ]);
  });

  it('runs a toolset that declares no auth config unchanged', async () => {
    const toolset = new AuthenticatedToolset();
    const mockLlm = new MockLlm([TEXT_RESPONSE]);
    const {runner, session} = await createRunner(createAgent(toolset, mockLlm));

    const events = await collectTurn(runner, session, {parts: [{text: 'go'}]});

    expect(events).toHaveLength(1);
    expect(events[0].content!.parts![0].text).toBe('done');
    expect(toolset.credentialsSeen.length).toBeGreaterThan(0);
    for (const credential of toolset.credentialsSeen) {
      expect(credential).toBeUndefined();
    }
    expect(mockLlm.callCount).toBe(1);
    expect(Object.keys(mockLlm.lastRequest!.toolsDict)).toEqual([
      'listed_tool',
    ]);
  });
});
