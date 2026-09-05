/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An LlmAgent on a GPT model, through the OpenAI Chat Completions API.
 *
 * The agent has one tool, so a run exercises both a plain answer and a
 * tool-calling turn.
 *
 * Run (needs the `openai` package and a live key):
 *   npm install openai
 *   export OPENAI_API_KEY=...
 *   npm run sample -- samples/models/openai/agent.ts
 */

import {FunctionTool, LlmAgent, OpenAILlm} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the current weather for a city.',
  parameters: z.object({
    city: z.string().describe('The name of the city.'),
  }),
  execute: ({city}) => `It is 21 degrees Celsius and sunny in ${city}.`,
});

export const rootAgent = new LlmAgent({
  name: 'openai_agent',
  model: new OpenAILlm({model: 'gpt-4o'}),
  instruction: 'You are a concise assistant. Use your tools when they apply.',
  tools: [getWeather],
});
