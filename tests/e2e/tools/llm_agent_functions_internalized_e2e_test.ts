/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RestApiTool,
} from '@google/adk';
import {createUserContent, Part} from '@google/genai';
import * as http from 'http';
import {OpenAPIV3} from 'openapi-types';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';

class ManualTestLlm extends BaseLlm {
  responses: LlmResponse[] = [];
  callCount = 0;

  constructor(responses: LlmResponse[]) {
    super({model: 'manual-e2e-llm'});
    this.responses = responses;
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

const API_KEY = 'valid-secret-key';

describe('Manual E2E Test: LlmAgent with long-running and authenticated tools', () => {
  let server: http.Server;
  let port: number;
  const receivedApiKeys: Array<string | string[] | undefined> = [];

  beforeAll(() => {
    server = http.createServer((req, res) => {
      receivedApiKeys.push(req.headers['x-api-key']);
      if (req.headers['x-api-key'] === API_KEY) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({status: 'authenticated_success'}));
      } else {
        res.writeHead(401);
        res.end('Unauthorized');
      }
    });
    return new Promise<void>((resolve) => {
      // Bind explicitly to IPv4 so the `baseUrl` below resolves identically on
      // every CI runner OS.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          port = address.port;
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('should detect longRunningToolIds, request credentials, and complete the authenticated call once credentials are supplied', async () => {
    const longRunningTool = new FunctionTool({
      name: 'long_processing_tool',
      description: 'A tool that runs for a long time',
      parameters: z.object({data: z.string()}),
      isLongRunning: true,
      execute: async ({data}) => {
        return {result: `Processed ${data}`};
      },
    });

    const endpoint = {
      baseUrl: `http://127.0.0.1:${port}`,
      path: '/data',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {
      responses: {
        '200': {
          description: 'Success',
          content: {
            'application/json': {
              schema: {type: 'object'},
            },
          },
        },
      },
    };
    const authScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };

    const authTool = new RestApiTool(
      'secure_api_tool',
      'A tool requiring auth',
      endpoint,
      operation,
      authScheme,
    );

    const manualLlm = new ManualTestLlm([
      // Step 1: LLM returns function calls for both the long-running tool and the auth tool
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'long_processing_tool',
                args: {data: 'payload_1'},
              },
            },
            {
              functionCall: {
                name: 'secure_api_tool',
                args: {},
              },
            },
          ],
        },
      },
      // Step 2: After credentials are provided and tool runs, LLM returns final answer
      {
        content: {
          role: 'model',
          parts: [{text: 'All tools executed successfully!'}],
        },
      },
    ]);

    const agent = new LlmAgent({
      name: 'manual_e2e_agent',
      model: manualLlm,
      tools: [longRunningTool, authTool],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'ManualE2EApp',
    });

    const session = await runner.sessionService.createSession({
      appName: 'ManualE2EApp',
      userId: 'test-user',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test-user',
      sessionId: session.id,
      newMessage: createUserContent('Execute both tools'),
    })) {
      events.push(event);
    }

    // Verify longRunningToolIds on the model event containing function calls.
    // `getLongRunningFunctionCalls` must select exactly the long-running call
    // and leave the non-long-running auth tool's call id out of the set.
    const modelCallEvent = events.find((e) =>
      e.content?.parts?.some(
        (p: Part) => p.functionCall?.name === 'long_processing_tool',
      ),
    );
    expect(modelCallEvent).toBeDefined();
    expect(modelCallEvent!.author).toBe('manual_e2e_agent');

    const longRunningCall = modelCallEvent!.content!.parts!.find(
      (p: Part) => p.functionCall?.name === 'long_processing_tool',
    )!.functionCall!;
    const authToolCall = modelCallEvent!.content!.parts!.find(
      (p: Part) => p.functionCall?.name === 'secure_api_tool',
    )!.functionCall!;
    expect(authToolCall.id).toBeDefined();
    expect(modelCallEvent!.longRunningToolIds).toEqual([longRunningCall.id]);

    // Verify adk_request_credential event was generated by internalized
    // generateAuthEvent, and that it points back at the auth tool's call.
    const authEvent = events.find((e) =>
      e.content?.parts?.some(
        (p: Part) => p.functionCall?.name === 'adk_request_credential',
      ),
    );
    expect(authEvent).toBeDefined();
    expect(authEvent!.author).toBe('manual_e2e_agent');
    const authRequestCall = authEvent!.content!.parts!.find(
      (p: Part) => p.functionCall?.name === 'adk_request_credential',
    )!.functionCall!;
    expect(authRequestCall.args!['function_call_id']).toBe(authToolCall.id);
    // generateAuthEvent marks every credential request as long-running.
    expect(authEvent!.longRunningToolIds).toEqual([authRequestCall.id]);

    // The server has not been reached yet: no credentials have been supplied.
    expect(receivedApiKeys).toEqual([]);

    // Second turn: supply the requested credential. The RestApiTool is retried,
    // actually calls the local server with the API key, and the agent produces
    // its final answer from the second canned LLM response.
    const resumedEvents: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test-user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'adk_request_credential',
              id: authRequestCall.id!,
              response: {
                authScheme,
                exchangedAuthCredential: {apiKey: API_KEY},
              },
            },
          },
        ],
      },
    })) {
      resumedEvents.push(event);
    }

    expect(receivedApiKeys).toEqual([API_KEY]);

    const toolResponseEvent = resumedEvents.find((e) =>
      e.content?.parts?.some(
        (p: Part) => p.functionResponse?.name === 'secure_api_tool',
      ),
    );
    expect(toolResponseEvent).toBeDefined();
    const toolResponse = toolResponseEvent!.content!.parts!.find(
      (p: Part) => p.functionResponse?.name === 'secure_api_tool',
    )!.functionResponse!;
    expect(toolResponse.response).toEqual({status: 'authenticated_success'});

    const finalEvent = resumedEvents[resumedEvents.length - 1];
    expect(finalEvent.content?.parts?.[0].text).toBe(
      'All tools executed successfully!',
    );
  });
});
