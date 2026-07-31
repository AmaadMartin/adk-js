/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredentialTypes,
  AuthenticatedFunctionTool,
  AuthScheme,
  BaseLlm,
  BaseLlmConnection,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryCredentialService,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PENDING_AUTH_RESPONSE,
  Runner,
} from '@google/adk';
import * as http from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

const API_KEY = 'test-api-key';
const CREDENTIAL_KEY = 'secured-api-credential';

const apiKeyScheme: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const authConfig: AuthConfig = {
  credentialKey: CREDENTIAL_KEY,
  authScheme: apiKeyScheme,
};

/** A stub model that replays a fixed script of responses. */
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

describe('AuthenticatedFunctionTool in an agent run', () => {
  let server: http.Server;
  let baseUrl: string;
  const receivedApiKeys: Array<string | undefined> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const apiKey = req.headers['x-api-key'];
      receivedApiKeys.push(typeof apiKey === 'string' ? apiKey : undefined);
      if (apiKey === API_KEY) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({items: ['first', 'second']}));
      } else {
        res.writeHead(401);
        res.end('Unauthorized');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail('Test server did not bind to a TCP port.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('asks for a credential, then calls the real endpoint with it once the client answers', async () => {
    const listItems = new AuthenticatedFunctionTool({
      name: 'list_items',
      description: 'Lists the items in a folder.',
      parameters: z.object({folder: z.string()}),
      authConfig,
      execute: async ({folder}, _toolContext, credential) => {
        const response = await fetch(`${baseUrl}/${folder}`, {
          headers: {'X-API-Key': credential?.apiKey ?? ''},
        });
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        return response.json();
      },
    });

    const toolCall = {
      name: 'list_items',
      args: {folder: 'inbox'},
      id: 'call_1',
    };
    const agent = new LlmAgent({
      name: 'auth_agent',
      model: new ScriptedLlm([
        {content: {role: 'model', parts: [{functionCall: toolCall}]}},
        {content: {role: 'model', parts: [{text: 'Found first and second.'}]}},
      ]),
      tools: [listItems],
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

    const firstTurn: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session.id,
      newMessage: {parts: [{text: 'List my items'}]},
    })) {
      firstTurn.push(event);
    }

    // The tool must not have reached the endpoint without a credential.
    expect(receivedApiKeys).toEqual([]);
    const authCalls = firstTurn.flatMap((event) =>
      getFunctionCalls(event).filter(
        (call) => call.name === 'adk_request_credential',
      ),
    );
    expect(authCalls).toHaveLength(1);
    const toolResponses = firstTurn.flatMap((event) =>
      getFunctionResponses(event).filter((r) => r.name === 'list_items'),
    );
    expect(toolResponses).toHaveLength(1);
    expect(toolResponses[0].response).toEqual({
      result: PENDING_AUTH_RESPONSE,
    });

    const secondTurn: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'adk_request_credential',
              id: authCalls[0].id,
              response: {
                authScheme: apiKeyScheme,
                credentialKey: CREDENTIAL_KEY,
                exchangedAuthCredential: {
                  authType: AuthCredentialTypes.API_KEY,
                  apiKey: API_KEY,
                },
              },
            },
          },
        ],
      },
    })) {
      secondTurn.push(event);
    }

    const retriedResponses = secondTurn.flatMap((event) =>
      getFunctionResponses(event).filter((r) => r.name === 'list_items'),
    );
    expect(retriedResponses).toHaveLength(1);
    expect(retriedResponses[0].response).toEqual({
      items: ['first', 'second'],
    });
    expect(receivedApiKeys).toEqual([API_KEY]);
  });
});
