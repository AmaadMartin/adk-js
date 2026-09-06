/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `OpenAILlm` through the real agent plumbing — `LlmAgent`, the runner,
 * the request processors and the function-call loop — against a client that
 * replays canned completions. It needs no network and no API key.
 */

import {FunctionTool, LlmAgent, OpenAIClient, OpenAILlm} from '@google/adk';
import type {OpenAI} from 'openai';
import {describe, expect, it} from 'vitest';

import {z} from 'zod';

import {createRunner} from '../../test_case_utils.js';

/** Replays one completion per call, and records what it was sent. */
class ScriptedOpenAIClient implements OpenAIClient {
  readonly bodies: OpenAI.Chat.ChatCompletionCreateParams[] = [];
  readonly chat: {completions: ScriptedCompletions};

  constructor(script: OpenAI.Chat.ChatCompletion[]) {
    this.chat = {completions: new ScriptedCompletions(this.bodies, script)};
  }
}

class ScriptedCompletions {
  private next = 0;

  constructor(
    private readonly bodies: OpenAI.Chat.ChatCompletionCreateParams[],
    private readonly script: OpenAI.Chat.ChatCompletion[],
  ) {}

  create(
    body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    options?: {signal?: AbortSignal},
  ): Promise<OpenAI.Chat.ChatCompletion>;
  create(
    body: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    options?: {signal?: AbortSignal},
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>;
  create(
    body: OpenAI.Chat.ChatCompletionCreateParams,
  ): Promise<
    OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
  > {
    this.bodies.push(body);
    const completion = this.script[this.next++];
    if (!completion) {
      return Promise.reject(
        new Error(`no scripted completion for call ${this.next}`),
      );
    }
    return Promise.resolve(completion);
  }
}

function completion(
  message: OpenAI.Chat.ChatCompletionMessage,
): OpenAI.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-1',
    created: 0,
    model: 'gpt-4o',
    object: 'chat.completion',
    choices: [{index: 0, finish_reason: 'stop', logprobs: null, message}],
    usage: {prompt_tokens: 10, completion_tokens: 4, total_tokens: 14},
  };
}

function textMessage(content: string): OpenAI.Chat.ChatCompletionMessage {
  return {role: 'assistant', content, refusal: null};
}

async function textOf(
  events: AsyncGenerator<{
    content?: {role?: string; parts?: Array<{text?: string}>};
  }>,
): Promise<string> {
  let text = '';
  for await (const event of events) {
    if (event.content?.role === 'model') {
      text += event.content.parts?.[0]?.text ?? '';
    }
  }
  return text;
}

describe('OpenAILlm through a runner', () => {
  it('answers a prompt and carries the system instruction', async () => {
    const client = new ScriptedOpenAIClient([
      completion(textMessage('Paris is the capital of France.')),
    ]);
    const agent = new LlmAgent({
      name: 'openai_agent',
      model: new OpenAILlm({model: 'gpt-4o', client}),
      instruction: 'You are a concise assistant.',
    });

    const runner = await createRunner(agent);
    const text = await textOf(runner.run('What is the capital of France?'));

    expect(text).toBe('Paris is the capital of France.');
    expect(client.bodies[0]?.messages[0]).toMatchObject({role: 'system'});
    expect(client.bodies[0]?.model).toBe('gpt-4o');
  });

  it('runs a tool call and feeds the result back to the model', async () => {
    const getWeather = new FunctionTool({
      name: 'get_weather',
      description: 'Returns the weather for a city.',
      parameters: z.object({city: z.string().describe('The city.')}),
      execute: ({city}) => `It is sunny in ${city}.`,
    });
    const client = new ScriptedOpenAIClient([
      completion({
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Paris"}',
            },
          },
        ],
      }),
      completion(textMessage('It is sunny in Paris.')),
    ]);
    const agent = new LlmAgent({
      name: 'openai_tool_agent',
      model: new OpenAILlm({model: 'gpt-4o', client}),
      tools: [getWeather],
    });

    const runner = await createRunner(agent);
    const text = await textOf(runner.run('What is the weather in Paris?'));

    expect(text).toBe('It is sunny in Paris.');
    expect(client.bodies[0]?.tools).toMatchObject([
      {type: 'function', function: {name: 'get_weather'}},
    ]);
    expect(client.bodies[1]?.messages).toContainEqual(
      expect.objectContaining({role: 'tool'}),
    );
  });
});
