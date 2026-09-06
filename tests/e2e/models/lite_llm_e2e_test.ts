/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  FunctionTool,
  InMemoryRunner,
  LiteLlm,
  LlmAgent,
  StreamingMode,
  ToolUnion,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as http from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';

const APP_NAME = 'lite_llm_e2e';
const USER_ID = 'e2e_user';

/** One chat-completions message, as the stub server reads it. */
interface StubMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
}

/** The request body the stub server reads. */
interface StubRequest {
  model: string;
  messages: StubMessage[];
  stream?: boolean;
}

/** Replies the stub server hands out, oldest first. */
type Reply = (request: StubRequest) => {status: number; body: string};

/** Reads and parses one request body. */
async function readBody(request: http.IncomingMessage): Promise<StubRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as StubRequest;
}

/** Builds a buffered chat-completions reply carrying plain text. */
function textReply(text: string): {status: number; body: string} {
  return {
    status: 200,
    body: JSON.stringify({
      choices: [
        {message: {role: 'assistant', content: text}, finish_reason: 'stop'},
      ],
    }),
  };
}

/** Builds a streamed chat-completions reply carrying text deltas. */
function streamedTextReply(deltas: string[]): {status: number; body: string} {
  const frames = deltas.map(
    (delta) =>
      `data: ${JSON.stringify({
        choices: [{delta: {role: 'assistant', content: delta}}],
      })}\n\n`,
  );
  const stop = `data: ${JSON.stringify({
    choices: [{delta: {role: 'assistant'}, finish_reason: 'stop'}],
  })}\n\n`;
  return {status: 200, body: `${frames.join('')}${stop}data: [DONE]\n\n`};
}

/** Builds a buffered reply asking for one tool call. */
function toolCallReply(
  id: string,
  name: string,
  args: string,
): {status: number; body: string} {
  return {
    status: 200,
    body: JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {type: 'function', id, function: {name, arguments: args}},
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  };
}

describe('LiteLlm against a local chat-completions server', () => {
  let server: http.Server;
  let apiBase: string;
  let replies: Reply[] = [];
  let received: StubRequest[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        received.push(body);
        const reply = replies.shift();
        if (!reply) {
          response.writeHead(500);
          response.end('no reply queued');
          return;
        }
        const {status, body: payload} = reply(body);
        response.writeHead(status, {'Content-Type': 'application/json'});
        response.end(payload);
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      expect.fail('the stub server did not report a port');
    }
    apiBase = `http://127.0.0.1:${address.port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  /** Runs one turn and returns every event the runner produced. */
  async function runTurn(
    agent: LlmAgent,
    prompt: string,
    streaming = false,
  ): Promise<Event[]> {
    const runner = new InMemoryRunner({agent, appName: APP_NAME});
    const session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: createUserContent(prompt),
      runConfig: streaming
        ? {streamingMode: StreamingMode.SSE}
        : {streamingMode: StreamingMode.NONE},
    })) {
      events.push(event);
    }
    return events;
  }

  function newAgent(tools: ToolUnion[] = []): LlmAgent {
    return new LlmAgent({
      name: 'lite_llm_agent',
      model: new LiteLlm({model: 'stub-model', apiBase}),
      tools,
    });
  }

  beforeAll(() => {
    replies = [];
    received = [];
  });

  it('answers a buffered turn with the model text', async () => {
    replies = [() => textReply('Hello from the stub.')];
    received = [];

    const events = await runTurn(newAgent(), 'Say hello.');

    expect(received).toHaveLength(1);
    expect(received[0].model).toBe('stub-model');
    expect(received[0].messages[0].role).toBe('system');
    expect(received[0].messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'Say hello.',
    });
    expect(events.at(-1)?.content?.parts?.[0].text).toBe(
      'Hello from the stub.',
    );
  });

  it('streams partial events and ends with a complete one', async () => {
    replies = [() => streamedTextReply(['Hel', 'lo ', 'there'])];
    received = [];

    const events = await runTurn(newAgent(), 'Say hello.', true);

    expect(received[0].stream).toBe(true);
    const partials = events.filter((event) => event.partial);
    expect(partials.map((event) => event.content?.parts?.[0].text)).toEqual([
      'Hel',
      'lo ',
      'there',
    ]);
    const last = events.at(-1);
    expect(last?.partial).toBeFalsy();
    expect(last?.content?.parts?.[0].text).toBe('Hello there');
  });

  it('runs a tool and returns its result with the matching tool_call_id', async () => {
    const getWeather = new FunctionTool({
      name: 'get_weather',
      description: 'Reports the weather in a city.',
      parameters: z.object({city: z.string()}),
      execute: (args) => ({forecast: `sunny in ${args.city}`}),
    });

    replies = [
      () => toolCallReply('call_abc', 'get_weather', '{"city": "Paris"}'),
      () => textReply('It is sunny in Paris.'),
    ];
    received = [];

    const events = await runTurn(newAgent([getWeather]), 'Weather in Paris?');

    expect(received).toHaveLength(2);
    const followUp = received[1].messages;
    const toolMessage = followUp.find((message) => message.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe('call_abc');
    expect(String(toolMessage?.content)).toContain('sunny in Paris');

    const toolResult = events.find(
      (event) => event.content?.parts?.[0].functionResponse,
    );
    expect(toolResult?.content?.parts?.[0].functionResponse?.name).toBe(
      'get_weather',
    );
    expect(events.at(-1)?.content?.parts?.[0].text).toBe(
      'It is sunny in Paris.',
    );
  });

  it('surfaces a server error with its status and body', async () => {
    replies = [() => ({status: 503, body: 'model overloaded'})];
    received = [];

    const events = await runTurn(newAgent(), 'Say hello.');

    const failure = events.find((event) => event.errorMessage);
    expect(failure?.errorMessage).toContain('503');
    expect(failure?.errorMessage).toContain('model overloaded');
  });
});
