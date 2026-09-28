/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthenticatedFunctionTool,
  BaseCredentialService,
  BaseLlm,
  BaseLlmConnection,
  Context,
  Event,
  InMemoryCredentialService,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PENDING_USER_AUTHORIZATION,
  Runner,
  getFunctionCalls,
  getFunctionResponses,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

const GRANTED_API_KEY = 'granted-api-key';

class ScriptedLlm extends BaseLlm {
  private callCount = 0;

  constructor(private readonly responses: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
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

function toolCall(id: string): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{functionCall: {name: 'list_documents', args: {}, id}}],
    },
  };
}

function modelText(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

/** An {@link InMemoryCredentialService} that records what the manager saves. */
class CountingCredentialService implements BaseCredentialService {
  readonly saved: AuthCredential[] = [];
  private readonly store = new InMemoryCredentialService();

  loadCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    return this.store.loadCredential(authConfig, toolContext);
  }

  async saveCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<void> {
    if (authConfig.exchangedAuthCredential) {
      this.saved.push(authConfig.exchangedAuthCredential);
    }
    return this.store.saveCredential(authConfig, toolContext);
  }
}

async function collect(
  events: AsyncGenerator<Event, void, void>,
): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function authRequestCall(events: Event[]) {
  return events
    .flatMap((event) => getFunctionCalls(event))
    .filter((call) => call.name === 'adk_request_credential');
}

function toolResponses(events: Event[]) {
  return events
    .flatMap((event) => getFunctionResponses(event))
    .filter((response) => response.name === 'list_documents');
}

describe('AuthenticatedFunctionTool through the Runner', () => {
  it('runs on the first call when the raw credential is already usable', async () => {
    const authConfig: AuthConfig = {
      authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      rawAuthCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'configured-api-key',
      },
      credentialKey: 'documents_api',
    };
    const tool = new AuthenticatedFunctionTool({
      name: 'list_documents',
      description: 'Lists the documents in a folder.',
      authConfig,
      execute: (_input, _toolContext, credential) => ({
        apiKey: credential.apiKey,
      }),
    });
    const agent = new LlmAgent({
      name: 'documents_agent',
      model: new ScriptedLlm([toolCall('call_1'), modelText('Listed them.')]),
      tools: [tool],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user_1',
    });
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
      credentialService: new InMemoryCredentialService(),
    });

    const events = await collect(
      runner.runAsync({
        userId: 'user_1',
        sessionId: session.id,
        newMessage: {parts: [{text: 'List my documents'}]},
      }),
    );

    expect(authRequestCall(events)).toHaveLength(0);
    expect(toolResponses(events)[0].response).toEqual({
      apiKey: 'configured-api-key',
    });
  });

  it('pauses for consent, then resumes and stores the granted credential', async () => {
    const credentialService = new CountingCredentialService();
    const tool = new AuthenticatedFunctionTool({
      name: 'list_documents',
      description: 'Lists the documents in a folder.',
      authConfig: {
        authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
        credentialKey: 'documents_api',
      },
      execute: (_input, _toolContext, credential) => ({
        apiKey: credential.apiKey,
      }),
    });
    const agent = new LlmAgent({
      name: 'documents_agent',
      model: new ScriptedLlm([
        toolCall('call_1'),
        modelText('Listed them.'),
        toolCall('call_2'),
        modelText('Listed them again.'),
      ]),
      tools: [tool],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user_1',
    });
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
      credentialService,
    });
    const run = (newMessage: Content) =>
      collect(
        runner.runAsync({userId: 'user_1', sessionId: session.id, newMessage}),
      );

    const firstTurn = await run({parts: [{text: 'List my documents'}]});

    const requests = authRequestCall(firstTurn);
    expect(requests).toHaveLength(1);
    expect(toolResponses(firstTurn)[0].response).toEqual({
      result: PENDING_USER_AUTHORIZATION,
    });
    expect(requests[0].args?.['auth_config']).toMatchObject({
      credentialKey: 'documents_api',
    });

    const secondTurn = await run({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'adk_request_credential',
            id: requests[0].id,
            response: {
              exchangedAuthCredential: {
                authType: AuthCredentialTypes.API_KEY,
                apiKey: GRANTED_API_KEY,
              },
            },
          },
        },
      ],
    });

    expect(toolResponses(secondTurn)[0].response).toEqual({
      apiKey: GRANTED_API_KEY,
    });
    expect(credentialService.saved).toEqual([
      {authType: AuthCredentialTypes.API_KEY, apiKey: GRANTED_API_KEY},
    ]);

    const thirdTurn = await run({parts: [{text: 'List them again'}]});

    expect(authRequestCall(thirdTurn)).toHaveLength(0);
    expect(toolResponses(thirdTurn)[0].response).toEqual({
      apiKey: GRANTED_API_KEY,
    });
  });
});
