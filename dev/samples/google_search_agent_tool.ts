/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  createGoogleSearchAgent,
  FunctionTool,
  GoogleSearchAgentTool,
  LlmAgent,
} from '@google/adk';
import {z} from 'zod';

const MODEL = 'gemini-2.5-flash';

const wordCountTool = new FunctionTool({
  name: 'count_words',
  description: 'Counts the words in a piece of text.',
  parameters: z.object({
    text: z.string().describe('The text to count the words of.'),
  }),
  execute: async ({text}) => ({wordCount: text.trim().split(/\s+/).length}),
});

export const rootAgent = new LlmAgent({
  model: MODEL,
  name: 'root_agent',
  description:
    'an agent that searches the web and counts the words in what it finds.',
  instruction:
    'Use the google_search_agent tool to look things up on the web. Use the count_words tool to count the words in an answer when the user asks for it.',
  tools: [
    new GoogleSearchAgentTool(createGoogleSearchAgent(MODEL)),
    wordCountTool,
  ],
});
