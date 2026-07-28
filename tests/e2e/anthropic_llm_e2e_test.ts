/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end tests for {@link AnthropicLlm}.
 *
 * These tests exercise the provider over the real `globalThis.fetch` (no fetch
 * mocking) against a local HTTP server that emulates the Anthropic Messages API
 * wire format, including SSE streaming. This proves the transport, request
 * serialization, header wiring, SSE parsing over a real network socket, and the
 * tool-call round trip actually work end to end without any external network or
 * credentials.
 */

import {AnthropicLlm, LlmRequest} from '@google/adk';
import {Content} from '@google/genai';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const LOCAL_API_KEY = 'local-e2e-key';

interface FakeServer {
  url: string;
  close: () => Promise<void>;
}

/** Emulates `POST /v1/messages` (JSON and SSE) for a Claude-shaped server. */
function startFakeAnthropicServer(): Promise<FakeServer> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(404).end('not found');
        return;
      }
      // A successful response proves the required headers were sent.
      if (
        req.headers['x-api-key'] !== LOCAL_API_KEY ||
        req.headers['anthropic-version'] !== '2023-06-01' ||
        !String(req.headers['content-type']).includes('application/json')
      ) {
        res.writeHead(401, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: 'missing or invalid headers'}));
        return;
      }

      const body = JSON.parse(raw) as {
        stream?: boolean;
        tools?: unknown[];
        messages: Array<{content: Array<{type: string}>}>;
      };
      const hasToolResult = body.messages.some((message) =>
        message.content.some((block) => block.type === 'tool_result'),
      );
      const wantsToolCall = !!body.tools && !hasToolResult;

      if (body.stream) {
        respondStreaming(res);
      } else {
        respondJson(res, wantsToolCall);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function respondJson(res: http.ServerResponse, wantsToolCall: boolean): void {
  const message = wantsToolCall
    ? {
        id: 'msg_tool',
        model: 'claude-sonnet-4-20250514',
        role: 'assistant',
        stop_reason: 'tool_use',
        stop_sequence: null,
        type: 'message',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_local_1',
            name: 'get_weather',
            input: {city: 'Paris'},
          },
        ],
        usage: {input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 4},
      }
    : {
        id: 'msg_text',
        model: 'claude-sonnet-4-20250514',
        role: 'assistant',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        content: [{type: 'text', text: 'It is sunny in Paris.'}],
        usage: {input_tokens: 25, output_tokens: 6, cache_read_input_tokens: 0},
      };
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify(message));
}

function respondStreaming(res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const send = (type: string, payload: object) => {
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({type, ...payload})}\n\n`,
    );
  };
  send('message_start', {
    message: {usage: {input_tokens: 12, output_tokens: 0}},
  });
  send('content_block_start', {
    index: 0,
    content_block: {type: 'text', text: ''},
  });
  send('content_block_delta', {
    index: 0,
    delta: {type: 'text_delta', text: 'Streaming '},
  });
  send('content_block_delta', {
    index: 0,
    delta: {type: 'text_delta', text: 'hello!'},
  });
  send('content_block_stop', {index: 0});
  send('message_delta', {
    delta: {stop_reason: 'end_turn'},
    usage: {output_tokens: 3},
  });
  send('message_stop', {});
  res.end();
}

function baseRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'claude-sonnet-4-20250514',
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    config: {
      systemInstruction: 'You are a helpful assistant',
      temperature: 0.1,
    },
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

async function collect<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

describe('AnthropicLlm E2E (local server, real fetch)', () => {
  let server: FakeServer;
  let llm: AnthropicLlm;

  beforeAll(async () => {
    server = await startFakeAnthropicServer();
    llm = new AnthropicLlm({apiKey: LOCAL_API_KEY, baseUrl: server.url});
  });

  afterAll(async () => {
    await server.close();
  });

  it('generates a non-streaming response over the wire', async () => {
    const responses = await collect(
      llm.generateContentAsync(baseRequest(), false),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0]?.text).toBe(
      'It is sunny in Paris.',
    );
    expect(responses[0].usageMetadata?.promptTokenCount).toBe(25);
    expect(responses[0].finishReason).toBe('STOP');
  });

  it('streams partials followed by a final aggregate over the wire', async () => {
    const responses = await collect(
      llm.generateContentAsync(baseRequest(), true),
    );
    const partials = responses.filter((r) => r.partial);
    const final = responses[responses.length - 1];
    expect(partials.map((r) => r.content?.parts?.[0]?.text)).toEqual([
      'Streaming ',
      'hello!',
    ]);
    expect(final.partial).toBe(false);
    expect(final.content?.parts?.[0]?.text).toBe('Streaming hello!');
    expect(final.usageMetadata?.promptTokenCount).toBe(12);
    expect(final.usageMetadata?.candidatesTokenCount).toBe(3);
  });

  it('completes a tool-call round trip over the wire', async () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Gets the weather for a city.',
            parameters: {
              type: 'OBJECT',
              properties: {city: {type: 'STRING'}},
              required: ['city'],
            },
          },
        ],
      },
    ];

    // Turn 1: the model asks to call the tool.
    const first = await collect(
      llm.generateContentAsync(
        baseRequest({
          contents: [{role: 'user', parts: [{text: 'Weather in Paris?'}]}],
          config: {tools} as never,
          toolsDict: {get_weather: {} as never},
        }),
        false,
      ),
    );
    const call = first[0].content?.parts?.[0]?.functionCall;
    expect(call?.name).toBe('get_weather');
    expect(call?.args).toEqual({city: 'Paris'});
    expect(call?.id).toBe('toolu_local_1');

    // Turn 2: send the tool result back and get the final answer.
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'Weather in Paris?'}]},
      {role: 'model', parts: [{functionCall: call}]},
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: call!.id,
              name: 'get_weather',
              response: {result: 'sunny'},
            },
          },
        ],
      },
    ];
    const second = await collect(
      llm.generateContentAsync(
        baseRequest({
          contents,
          config: {tools} as never,
          toolsDict: {get_weather: {} as never},
        }),
        false,
      ),
    );
    expect(second[0].content?.parts?.[0]?.text).toBe('It is sunny in Paris.');
    expect(second[0].finishReason).toBe('STOP');
  });

  it('throws a descriptive error when the server rejects the request', async () => {
    const badLlm = new AnthropicLlm({apiKey: 'wrong-key', baseUrl: server.url});
    await expect(
      collect(badLlm.generateContentAsync(baseRequest(), false)),
    ).rejects.toThrow(/status 401/);
  });
});
