/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end tests for {@link ChatCompletionsLlm} with NO mocks. A real
 * OpenAI-compatible HTTP server runs in-process (localhost) and is exercised
 * over the platform-native `fetch`, both directly and through a real
 * `LlmAgent` + `InMemoryRunner`, proving the transport, request construction,
 * response mapping, streaming, and function-calling round trip all work
 * against a genuine server.
 *
 * This mirrors the manual verification against a local Ollama / vLLM / LM
 * Studio endpoint (`http://localhost:11434/v1`) described in the design, but
 * is fully self-contained so it needs no external services or credentials.
 */
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {AddressInfo} from 'node:net';

import {createUserContent} from '@google/genai';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

import {
  ChatCompletionsLlm,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
} from '@google/adk';

interface ChatMessage {
  role: string;
  content: string | null;
}

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
}

/** Records the last request the server received, for assertions. */
interface CapturedRequest {
  authorization?: string;
  body?: ChatRequestBody;
}

const captured: CapturedRequest = {};

/** True when a tool result message is already present in the conversation. */
function hasToolResult(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'tool');
}

/** Builds the OpenAI-style response object for a given request body. */
function buildResponse(body: ChatRequestBody): Record<string, unknown> {
  const wantsTool =
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    !hasToolResult(body.messages);

  if (wantsTool) {
    return {
      id: 'chatcmpl-tool',
      object: 'chat.completion',
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_weather_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: JSON.stringify({location: 'London'}),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {prompt_tokens: 5, completion_tokens: 3, total_tokens: 8},
    };
  }

  const toolMessage = body.messages.find((message) => message.role === 'tool');
  const answer = toolMessage
    ? `The weather in London is ${toolMessage.content}.`
    : 'Hello from the test server.';
  return {
    id: 'chatcmpl-text',
    object: 'chat.completion',
    created: 2,
    model: body.model,
    choices: [
      {
        index: 0,
        message: {role: 'assistant', content: answer},
        finish_reason: 'stop',
      },
    ],
    usage: {prompt_tokens: 6, completion_tokens: 4, total_tokens: 10},
  };
}

/** Encodes a text answer as a sequence of SSE `chat.completion.chunk` lines. */
function textStreamLines(text: string, model: string): string[] {
  const words = text.split(' ');
  const lines = words.map((word, index) => {
    const delta = {content: index === 0 ? word : ` ${word}`};
    return `data: ${JSON.stringify({
      id: 'chatcmpl-stream',
      object: 'chat.completion.chunk',
      created: 3,
      model,
      choices: [{index: 0, delta, finish_reason: null}],
    })}\n\n`;
  });
  lines.push(
    `data: ${JSON.stringify({
      id: 'chatcmpl-stream',
      object: 'chat.completion.chunk',
      created: 3,
      model,
      choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
      usage: {
        prompt_tokens: 6,
        completion_tokens: words.length,
        total_tokens: 6 + words.length,
      },
    })}\n\n`,
  );
  lines.push('data: [DONE]\n\n');
  return lines;
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const body = JSON.parse(raw) as ChatRequestBody;
    captured.authorization = req.headers['authorization'] as string | undefined;
    captured.body = body;

    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }

    const response = buildResponse(body);
    if (body.stream) {
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const message = (
        response['choices'] as Array<Record<string, unknown>>
      )[0]['message'] as {content: string};
      for (const line of textStreamLines(message.content, body.model)) {
        res.write(line);
      }
      res.end();
      return;
    }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(response));
  });
}

describe('ChatCompletionsLlm end-to-end (real local server)', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    server = createServer(handleRequest);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const {port} = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('completes a non-streaming turn over real HTTP', async () => {
    const llm = new ChatCompletionsLlm({
      baseURL,
      model: 'test-model',
      apiKey: 'test-key',
    });
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Say hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: string[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response.content!.parts![0].text!);
    }

    expect(responses).toEqual(['Hello from the test server.']);
    expect(captured.authorization).toBe('Bearer test-key');
    expect(captured.body!.model).toBe('test-model');
  });

  it('streams a turn over real HTTP', async () => {
    const llm = new ChatCompletionsLlm({baseURL, model: 'test-model'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Say hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const partials: string[] = [];
    let finalText = '';
    for await (const response of llm.generateContentAsync(request, true)) {
      if (response.partial) {
        if (response.content?.parts?.[0]?.text) {
          partials.push(response.content.parts[0].text);
        }
      } else {
        finalText = response.content!.parts![0].text!;
        expect(response.finishReason).toBeDefined();
      }
    }

    expect(partials.length).toBeGreaterThan(1);
    expect(finalText).toBe('Hello from the test server.');
  });

  it('drives function calling through a real LlmAgent and runner', async () => {
    const calls: Array<{location: string}> = [];
    const getWeather = new FunctionTool({
      name: 'get_weather',
      description: 'Get the current weather for a location.',
      parameters: z.object({location: z.string()}),
      execute: (input) => {
        calls.push(input);
        return {report: 'sunny, 20C'};
      },
    });

    const agent = new LlmAgent({
      name: 'weather_assistant',
      description: 'Answers weather questions.',
      instruction: 'Use the get_weather tool to answer weather questions.',
      model: new ChatCompletionsLlm({baseURL, model: 'test-model'}),
      tools: [getWeather],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'chat_completions_e2e',
    });
    const session = await runner.sessionService.createSession({
      appName: 'chat_completions_e2e',
      userId: 'test_user',
    });

    let finalText = '';
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent("What's the weather in London?"),
    })) {
      const text = event.content?.parts?.find((part) => part.text)?.text;
      if (text) {
        finalText = text;
      }
    }

    expect(calls).toEqual([{location: 'London'}]);
    expect(finalText).toContain('sunny, 20C');
  });
});
