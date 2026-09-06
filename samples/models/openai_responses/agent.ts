/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An agent backed by a GPT model over the OpenAI Responses API.
 *
 * `OpenAIResponsesLlm` is experimental and is not registered against any model
 * name, so the model instance is assigned to the agent directly.
 *
 * Setup:
 *   npm install openai
 *   export OPENAI_API_KEY=<your-key>
 *
 * Run:
 *   npm run sample -- samples/models/openai_responses/agent.ts
 *
 * Ask it "What is the weather in Paris?" to exercise the tool call.
 */

import {FunctionTool, LlmAgent, OpenAIResponsesLlm} from '@google/adk';
import {z} from 'zod';

/** Reports a canned forecast, so the sample needs no weather provider. */
const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the current weather for a location.',
  parameters: z.object({
    location: z.string().describe('The city to report on.'),
  }),
  execute: ({location}) => `It is 21 degrees Celsius and sunny in ${location}.`,
});

export const rootAgent = new LlmAgent({
  name: 'openai_responses_agent',
  model: new OpenAIResponsesLlm({model: 'gpt-5'}),
  instruction:
    'You are a concise assistant. Use the get_weather tool when the user ' +
    'asks about the weather.',
  tools: [getWeather],
});
