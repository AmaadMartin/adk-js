/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An LlmAgent on a GPT model, through the OpenAI Responses API.
 *
 * The agent has one tool and asks for medium reasoning effort, so a run
 * exercises a plain answer, a tool-calling turn, and the reasoning mapping.
 *
 * Run (needs the `openai` package and a live key):
 *   npm install openai
 *   export OPENAI_API_KEY=...
 *   npm run sample -- samples/models/openai_responses/agent.ts
 */

import {FunctionTool, LlmAgent, OpenAIResponsesLlm} from '@google/adk';
import {ThinkingLevel} from '@google/genai';
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
  name: 'openai_responses_agent',
  model: new OpenAIResponsesLlm({
    model: 'gpt-5',
    include: ['reasoning.encrypted_content'],
  }),
  instruction: 'You are a concise assistant. Use your tools when they apply.',
  tools: [getWeather],
  generateContentConfig: {
    thinkingConfig: {thinkingLevel: ThinkingLevel.MEDIUM},
  },
});
