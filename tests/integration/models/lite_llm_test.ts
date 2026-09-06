/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  ContextCacheConfig,
  FunctionTool,
  LiteLlm,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {createRunner} from '../test_case_utils.js';

/** A chat-completions endpoint that replays canned responses. */
interface FakeEndpoint {
  /** The base URL to give {@link LiteLlm}. */
  apiBase: string;
  /** The body of every request the endpoint received, in order. */
  requests: Array<Record<string, unknown>>;
  /** The headers of every request the endpoint received, in order. */
  headers: IncomingHttpHeaders[];
  close(): Promise<void>;
}

/** A response the fake endpoint sends back, buffered or as an event stream. */
type Reply = {kind: 'json'; body: unknown} | {kind: 'sse'; frames: unknown[]};

let endpoint: FakeEndpoint | undefined;

afterEach(async () => {
  await endpoint?.close();
  endpoint = undefined;
});

/** Reads a request body as JSON. */
async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

/** Writes one reply to the wire. */
function writeReply(response: ServerResponse, reply: Reply): void {
  if (reply.kind === 'json') {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(reply.body));
    return;
  }
  response.writeHead(200, {'Content-Type': 'text/event-stream'});
  for (const frame of reply.frames) {
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}

/** Starts an endpoint that answers each request with the next reply. */
async function startEndpoint(replies: Reply[]): Promise<FakeEndpoint> {
  const requests: Array<Record<string, unknown>> = [];
  const headers: IncomingHttpHeaders[] = [];
  let served = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      headers.push(request.headers);
      requests.push(await readJsonBody(request));
      const reply = replies[served++];
      if (!reply) {
        response.writeHead(500).end('no reply left');
        return;
      }
      writeReply(response, reply);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as AddressInfo;

  return {
    apiBase: `http://127.0.0.1:${port}/v1`,
    requests,
    headers,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A buffered response carrying one line of text. */
function textReply(text: string): Reply {
  return {
    kind: 'json',
    body: {
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {role: 'assistant', content: text},
          finish_reason: 'stop',
        },
      ],
      usage: {prompt_tokens: 9, completion_tokens: 3, total_tokens: 12},
    },
  };
}

/** A buffered response asking for one tool call. */
function toolCallReply(name: string, args: string): Reply {
  return {
    kind: 'json',
    body: {
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {name, arguments: args},
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  };
}

/** The base64 thought signature the fake Claude endpoint returns. */
const CLAUDE_SIGNATURE = 'c2lnX2NsYXVkZQ==';

/** A Claude reply carrying a signed thinking block and one tool call. */
function claudeThinkingToolCallReply(): Reply {
  return {
    kind: 'json',
    body: {
      model: 'claude-sonnet-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            thinking_blocks: [
              {
                type: 'thinking',
                thinking: 'The user asks about Paris.',
                signature: CLAUDE_SIGNATURE,
              },
            ],
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"Paris"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  };
}

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the weather for a location.',
  parameters: z.object({
    location: z.string().describe('The location to look up.'),
  }),
  execute: ({location}) => `It is sunny in ${location}.`,
});

/** Builds an agent that talks to the fake endpoint. */
function agentFor(apiBase: string, tools: BaseTool[] = []): LlmAgent {
  return new LlmAgent({
    name: 'lite_llm_integration_agent',
    model: new LiteLlm({model: 'openai/gpt-4o', apiBase}),
    instruction: 'You are a helpful assistant.',
    tools,
  });
}

/** Collects the model text an agent run produced. */
async function runAgent(agent: LlmAgent, prompt: string): Promise<string> {
  const runner = await createRunner(agent);
  let text = '';
  for await (const event of runner.run(prompt)) {
    for (const part of event.content?.parts ?? []) {
      if (event.content?.role === 'model' && part.text) {
        text += part.text;
      }
    }
  }
  return text;
}

/** Builds a one-turn request carrying nothing but the prompt. */
function textRequest(text: string): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** Builds a history whose last turn answers a tool call. */
function historyWithToolResult(): LlmRequest {
  return {
    contents: [
      {role: 'user', parts: [{text: 'What is the weather in Paris?'}]},
      {
        role: 'model',
        parts: [{functionCall: {id: 'call_1', name: 'get_weather', args: {}}}],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_1',
              name: 'get_weather',
              response: {report: 'It is sunny in Paris.'},
            },
          },
        ],
      },
    ],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** Drains a non-streaming generation. */
async function collectResponses(
  model: LiteLlm,
  llmRequest: LlmRequest,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of model.generateContentAsync(llmRequest)) {
    responses.push(response);
  }
  return responses;
}

describe('LiteLlm against a local chat-completions endpoint', () => {
  it('answers a single turn', async () => {
    endpoint = await startEndpoint([textReply('Hello from the endpoint.')]);

    const text = await runAgent(agentFor(endpoint.apiBase), 'Say hello.');

    expect(text).toBe('Hello from the endpoint.');
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]['model']).toBe('openai/gpt-4o');

    const messages = endpoint.requests[0]['messages'] as Array<
      Record<string, unknown>
    >;
    expect(messages[0]['role']).toBe('system');
    expect(String(messages[0]['content'])).toContain(
      'You are a helpful assistant.',
    );
    expect(messages[1]).toEqual({role: 'user', content: 'Say hello.'});
  });

  it('calls a tool and answers with its result', async () => {
    endpoint = await startEndpoint([
      toolCallReply('get_weather', '{"location": "Paris"}'),
      textReply('It is sunny in Paris.'),
    ]);

    const text = await runAgent(
      agentFor(endpoint.apiBase, [getWeather]),
      'What is the weather in Paris?',
    );

    expect(text).toBe('It is sunny in Paris.');
    expect(endpoint.requests).toHaveLength(2);
    expect(endpoint.requests[0]['tools']).toMatchObject([
      {type: 'function', function: {name: 'get_weather'}},
    ]);

    const followUp = endpoint.requests[1]['messages'] as Array<
      Record<string, unknown>
    >;
    const toolMessage = followUp[followUp.length - 1];
    expect(toolMessage['role']).toBe('tool');
    expect(toolMessage['tool_call_id']).toBe('call_1');
    expect(String(toolMessage['content'])).toContain('It is sunny in Paris.');
  });

  it('reads a streamed answer as partials and one aggregate', async () => {
    endpoint = await startEndpoint([
      {
        kind: 'sse',
        frames: [
          {
            model: 'gpt-4o',
            choices: [
              {index: 0, delta: {role: 'assistant', content: 'Hello '}},
            ],
          },
          {model: 'gpt-4o', choices: [{index: 0, delta: {content: 'world'}}]},
          {
            model: 'gpt-4o',
            choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
          },
          {
            model: 'gpt-4o',
            choices: [],
            usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6},
          },
        ],
      },
    ]);

    const model = new LiteLlm({
      model: 'openai/gpt-4o',
      apiBase: endpoint.apiBase,
    });
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Say hello.'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of model.generateContentAsync(llmRequest, true)) {
      responses.push(response);
    }

    expect(responses.map((response) => response.partial)).toEqual([
      true,
      true,
      false,
    ]);
    expect(responses[2].content?.parts).toEqual([{text: 'Hello world'}]);
    expect(responses[2].usageMetadata?.totalTokenCount).toBe(6);
    expect(endpoint.requests[0]['stream']).toBe(true);
  });

  it('puts the cache breakpoints and the tracking headers in the body', async () => {
    endpoint = await startEndpoint([textReply('Cached.')]);

    const model = new LiteLlm({
      model: 'vertex_ai/gemini-2.5-flash',
      apiBase: endpoint.apiBase,
    });
    const cacheConfig: ContextCacheConfig = {ttlSeconds: 3600, minTokens: 0};
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Say hello.'}]}],
      liveConnectConfig: {},
      toolsDict: {},
      cacheConfig,
    };

    for await (const _ of model.generateContentAsync(llmRequest)) {
      // The reply is not what this test is about; the request is.
    }

    expect(endpoint.requests[0]['cache_control_injection_points']).toEqual([
      {
        location: 'message',
        role: 'system',
        control: {type: 'ephemeral', ttl: '1h'},
      },
      {
        location: 'message',
        index: -1,
        control: {type: 'ephemeral', ttl: '1h'},
      },
    ]);
    // The tracking headers travel as a request parameter, because a LiteLLM
    // Proxy passes that to the provider and does not forward its own headers.
    const headers = endpoint.requests[0]['headers'] as Record<string, string>;
    expect(headers['x-goog-api-client']).toContain('google-adk/');
    expect(headers['user-agent']).toContain('gl-typescript/');
    expect(endpoint.headers[0]['x-goog-api-client']).toBeUndefined();
  });

  it('reads token counts from a usage block sent as a JSON string', async () => {
    endpoint = await startEndpoint([
      {
        kind: 'json',
        body: {
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: {role: 'assistant', content: 'hi'},
              finish_reason: 'stop',
            },
          ],
          usage: JSON.stringify({
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            cached_tokens: 3,
            cache_creation_input_tokens: 2,
            completion_tokens_details: {reasoning_tokens: 5},
          }),
        },
      },
    ]);

    const model = new LiteLlm({
      model: 'openai/gpt-4o',
      apiBase: endpoint.apiBase,
    });
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of model.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses[0].usageMetadata).toMatchObject({
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      totalTokenCount: 14,
      cachedContentTokenCount: 3,
      thoughtsTokenCount: 5,
    });
  });

  it('sends a Gemma 4 tool result under the tool_responses role', async () => {
    endpoint = await startEndpoint([textReply('It is sunny in Paris.')]);

    const model = new LiteLlm({
      model: 'ollama/gemma4:e2b',
      apiBase: endpoint.apiBase,
    });

    await collectResponses(model, historyWithToolResult());

    const messages = endpoint.requests[0]['messages'] as Array<
      Record<string, unknown>
    >;
    const toolMessage = messages[messages.length - 1];
    expect(toolMessage['role']).toBe('tool_responses');
    expect(toolMessage['tool_call_id']).toBe('call_1');
  });

  it('sends a non-Gemma tool result under the tool role', async () => {
    endpoint = await startEndpoint([textReply('It is sunny in Paris.')]);

    const model = new LiteLlm({
      model: 'openai/gpt-4o',
      apiBase: endpoint.apiBase,
    });

    await collectResponses(model, historyWithToolResult());

    const messages = endpoint.requests[0]['messages'] as Array<
      Record<string, unknown>
    >;
    expect(messages[messages.length - 1]['role']).toBe('tool');
  });

  it('sends the cache control injection points in the body', async () => {
    endpoint = await startEndpoint([textReply('Cached.')]);

    const model = new LiteLlm({
      model: 'anthropic/claude-sonnet-4',
      apiBase: endpoint.apiBase,
    });

    await collectResponses(model, {
      ...textRequest('Summarize the document.'),
      cacheConfig: {ttlSeconds: 3600, minTokens: 0},
    });

    expect(endpoint.requests[0]['cache_control_injection_points']).toEqual([
      {
        location: 'message',
        role: 'system',
        control: {type: 'ephemeral', ttl: '1h'},
      },
      {location: 'message', index: -1, control: {type: 'ephemeral', ttl: '1h'}},
    ]);
  });

  it('sends no injection points when the App configures no cache', async () => {
    endpoint = await startEndpoint([textReply('Hi.')]);

    const text = await runAgent(agentFor(endpoint.apiBase), 'Say hello.');

    expect(text).toBe('Hi.');
    expect(endpoint.requests[0]).not.toHaveProperty(
      'cache_control_injection_points',
    );
  });

  it('sends the tracking headers to a vertex model', async () => {
    endpoint = await startEndpoint([textReply('Hi.')]);

    const model = new LiteLlm({
      model: 'vertex_ai/gemini-2.5-flash',
      apiBase: endpoint.apiBase,
    });

    await collectResponses(model, textRequest('Say hi.'));

    const headers = endpoint.requests[0]['headers'] as Record<string, string>;
    expect(headers['x-goog-api-client']).toContain('google-adk/');
    expect(endpoint.requests[0]).not.toHaveProperty('extra_headers');
  });

  it('sends no tracking headers to another provider', async () => {
    endpoint = await startEndpoint([textReply('Hi.')]);

    const model = new LiteLlm({
      model: 'openai/gpt-4o',
      apiBase: endpoint.apiBase,
    });

    await collectResponses(model, textRequest('Say hi.'));

    expect(endpoint.requests[0]).not.toHaveProperty('headers');
    expect(endpoint.headers[0]['x-goog-api-client']).toBeUndefined();
  });

  it('reports an endpoint error', async () => {
    endpoint = await startEndpoint([]);

    const model = new LiteLlm({
      model: 'openai/gpt-4o',
      apiBase: endpoint.apiBase,
    });
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await expect(
      (async () => {
        for await (const _ of model.generateContentAsync(llmRequest)) {
          // The first request rejects, so nothing is ever yielded.
        }
      })(),
    ).rejects.toThrow('failed with status 500: no reply left');
  });
  it('resends a Claude turn its thinking blocks on the next request', async () => {
    endpoint = await startEndpoint([
      claudeThinkingToolCallReply(),
      textReply('It is sunny in Paris.'),
    ]);
    const agent = new LlmAgent({
      name: 'lite_llm_anthropic_agent',
      model: new LiteLlm({
        model: 'anthropic/claude-sonnet-4',
        apiBase: endpoint.apiBase,
      }),
      instruction: 'You are a helpful assistant.',
      tools: [getWeather],
    });

    await runAgent(agent, 'What is the weather in Paris?');

    expect(endpoint.requests).toHaveLength(2);
    const messages = endpoint.requests[1]['messages'] as Array<
      Record<string, unknown>
    >;
    const assistant = messages.find(
      (message) => message['role'] === 'assistant',
    );
    expect(assistant?.['thinking_blocks']).toEqual([
      {
        type: 'thinking',
        thinking: 'The user asks about Paris.',
        signature: CLAUDE_SIGNATURE,
      },
    ]);
    expect(assistant?.['reasoning_content']).toBeUndefined();
  });
});
