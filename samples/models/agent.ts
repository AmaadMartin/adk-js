/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Models beyond Gemini
 * ../../docs/guides/models/index.md
 *
 * One agent, two tools, and a choice of model that is not Gemini: `LiteLlm`
 * against any OpenAI-compatible chat-completions server, or `Claude` on Vertex
 * AI. The agent, its instruction and its tools are the same either way; only
 * the `BaseLlm` instance passed as `model` changes. The tools and the
 * instruction are adk-python's `hello_world_litellm` sample.
 *
 * `LiteLlm` does not bundle a client. It converts the request into
 * chat-completions messages and tools and hands them to the `LiteLlmClient` you
 * pass in, which here is `ChatCompletionsClient` in the file beside this one.
 *
 * REQUIRES a model server. With a LiteLLM proxy on its default port:
 *   litellm --model gpt-4o
 *   npm run sample -- samples/models/agent.ts
 * Or against OpenAI directly:
 *   CHAT_COMPLETIONS_BASE_URL=https://api.openai.com/v1 \
 *   CHAT_COMPLETIONS_API_KEY=... npm run sample -- samples/models/agent.ts
 * Or Claude on Vertex AI (GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION set,
 * application default credentials configured):
 *   ADK_SAMPLE_MODEL=claude-3-5-sonnet-v2@20241022 \
 *   npm run sample -- samples/models/agent.ts
 * Try "roll a 12-sided die and check whether the result is prime".
 */

import {BaseLlm, Claude, FunctionTool, LiteLlm, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {ChatCompletionsClient} from './chat_completions_client.js';

const MODEL = process.env['ADK_SAMPLE_MODEL'] ?? 'gpt-4o';

function createModel(model: string): BaseLlm {
  if (model.startsWith('claude-')) {
    return new Claude({model});
  }
  return new LiteLlm({
    model,
    llmClient: new ChatCompletionsClient(
      process.env['CHAT_COMPLETIONS_BASE_URL'] ?? 'http://localhost:4000',
      process.env['CHAT_COMPLETIONS_API_KEY'],
    ),
  });
}

const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Roll a die and return the rolled result.',
  parameters: z.object({
    sides: z
      .number()
      .int()
      .describe('The integer number of sides the die has.'),
  }),
  execute: ({sides}) => Math.floor(Math.random() * sides) + 1,
});

const checkPrime = new FunctionTool({
  name: 'check_prime',
  description: 'Check if a given list of numbers are prime.',
  parameters: z.object({
    nums: z.array(z.number().int()).describe('The list of numbers to check.'),
  }),
  execute: ({nums}) => {
    const primes = nums.filter(isPrime);
    return primes.length === 0
      ? 'No prime numbers found.'
      : `${primes.join(', ')} are prime numbers.`;
  },
});

function isPrime(n: number): boolean {
  if (n <= 1) {
    return false;
  }
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) {
      return false;
    }
  }
  return true;
}

export const rootAgent = new LlmAgent({
  name: 'data_processing_agent',
  model: createModel(MODEL),
  description:
    'hello world agent that can roll a dice of 8 sides and check prime numbers.',
  instruction: `You roll dice and answer questions about the outcome of the dice rolls.
When you are asked to roll a die, you must call the roll_die tool with the number of sides. Be sure to pass in an integer.
You should never roll a die on your own.
When checking prime numbers, call the check_prime tool with a list of integers.
When you are asked to roll a die and check prime numbers, first call roll_die, wait for its result, then call check_prime with that result.
When you respond, you must include the roll_die result.`,
  tools: [rollDie, checkPrime],
});
