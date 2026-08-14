/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AnthropicMessagesClient, Event} from '@google/adk';
import {AnthropicLlm, FunctionTool, LlmAgent} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

import {createRunner, tick} from '../../test_case_utils.js';

/** A hermetic AnthropicLlm whose network client returns queued responses. */
class AnthropicLlmWithMockResponses extends AnthropicLlm {
  readonly createCalls: Array<Record<string, unknown>> = [];
  private index = 0;

  constructor(private readonly responses: unknown[]) {
    super({model: 'claude-sonnet-4-20250514', apiKey: 'test-key'});
  }

  protected override createAnthropicClient(): AnthropicMessagesClient {
    const create = async (params: Record<string, unknown>) => {
      this.createCalls.push(params);
      await tick();
      if (this.index >= this.responses.length) {
        throw new Error('No more mock responses available.');
      }
      return this.responses[this.index++];
    };
    return {
      messages: {
        create:
          create as unknown as AnthropicMessagesClient['messages']['create'],
      },
    };
  }
}

function textMessage(text: string) {
  return {
    id: 'msg_text',
    content: [{type: 'text', text, citations: null}],
    model: 'claude-sonnet-4-20250514',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0},
  };
}

function toolUseMessage(id: string, name: string, input: unknown) {
  return {
    id: 'msg_tool',
    content: [{type: 'tool_use', id, name, input}],
    model: 'claude-sonnet-4-20250514',
    role: 'assistant',
    stop_reason: 'tool_use',
    stop_sequence: null,
    type: 'message',
    usage: {input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 0},
  };
}

async function collectModelText(
  gen: AsyncGenerator<Event, void, undefined>,
): Promise<string> {
  let text = '';
  for await (const event of gen) {
    if (event.content?.role === 'model') {
      for (const part of event.content.parts ?? []) {
        text += part.text ?? '';
      }
    }
  }
  return text;
}

describe('AnthropicLlm runner integration', () => {
  it('drives a single non-streaming turn through the runner', async () => {
    const model = new AnthropicLlmWithMockResponses([
      textMessage('Hello from Claude.'),
    ]);
    const agent = new LlmAgent({
      name: 'assistant',
      model,
      instruction: 'You are a helpful assistant.',
    });

    const runner = await createRunner(agent);
    const text = await collectModelText(runner.run('Hi there'));

    expect(text).toContain('Hello from Claude.');
    expect(model.createCalls).toHaveLength(1);
  });

  it('round-trips a tool call end-to-end', async () => {
    const getWeatherTool = new FunctionTool({
      name: 'get_weather',
      description: 'Retrieves the current weather report for a city.',
      parameters: z.object({
        city: z.string().describe('The name of the city.'),
      }),
      execute: async ({city}: {city: string}) => ({
        status: 'success',
        report: `The weather in ${city} is sunny.`,
      }),
    });

    const model = new AnthropicLlmWithMockResponses([
      toolUseMessage('toolu_1', 'get_weather', {city: 'Paris'}),
      textMessage('It is sunny in Paris.'),
    ]);

    const agent = new LlmAgent({
      name: 'assistant',
      model,
      instruction: 'Answer questions about the weather.',
      tools: [getWeatherTool],
    });

    const runner = await createRunner(agent);
    const text = await collectModelText(
      runner.run('What is the weather in Paris?'),
    );

    expect(text).toContain('It is sunny in Paris.');
    // Two model calls: the tool_use turn and the final text turn.
    expect(model.createCalls).toHaveLength(2);

    // tool_choice is set because the agent registered a tool.
    expect(model.createCalls[0]['tool_choice']).toEqual({type: 'auto'});

    // The follow-up request echoes the tool result back to Claude, proving the
    // functionResponse -> tool_result conversion round-trips through the flow.
    const followUpMessages = model.createCalls[1]['messages'] as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const toolResultBlocks = followUpMessages
      .flatMap((message) => message.content)
      .filter((block) => block['type'] === 'tool_result');
    expect(toolResultBlocks).toHaveLength(1);
    expect(toolResultBlocks[0]['tool_use_id']).toBe('toolu_1');
  });
});
