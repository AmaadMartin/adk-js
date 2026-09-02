/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionTool,
  InMemoryRunner,
  LiteLlm,
  LlmAgent,
  LlmRequest,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

/**
 * Exercises a real endpoint, so it is skipped unless one is configured.
 *
 * Point `LITELLM_API_BASE` at an OpenAI-compatible `/v1` endpoint (a LiteLLM
 * Proxy deployment, OpenAI, or a local Ollama or vLLM server), set
 * `LITELLM_API_KEY` if it needs one, and set `LITELLM_MODEL` to a model that
 * endpoint serves.
 */
const apiBase = process.env['LITELLM_API_BASE'];
const model = process.env['LITELLM_MODEL'] ?? 'openai/gpt-4o-mini';

/**
 * The Gemma 4 case needs a Gemma 4 the endpoint actually serves, so it reads
 * its own variable and is skipped without one.
 */
const gemmaModel = process.env['LITELLM_GEMMA4_MODEL'];

/** Bounds the tool round trip: a looping model never reaches this. */
const MAX_TOOL_ROUND_TRIP_CALLS = 4;

describe.skipIf(!apiBase)('LiteLlm against a real endpoint', () => {
  it('answers one completion', async () => {
    const llm = new LiteLlm({
      model,
      apiBase,
      apiKey: process.env['LITELLM_API_KEY'],
    });
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Reply with the word OK.'}]}],
      config: {systemInstruction: 'Answer in one word.', maxOutputTokens: 16},
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses = [];
    for await (const response of llm.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0].text).toBeTruthy();
  });
});

describe.skipIf(!apiBase || !gemmaModel)('LiteLlm against a Gemma 4', () => {
  it('finishes a tool round trip instead of re-calling the tool', async () => {
    let calls = 0;
    const getWeather = new FunctionTool({
      name: 'get_weather',
      description: 'Returns the weather for a location.',
      parameters: z.object({
        location: z.string().describe('The location to look up.'),
      }),
      execute: ({location}) => {
        calls++;
        return `It is sunny in ${location}.`;
      },
    });

    const runner = new InMemoryRunner({
      appName: 'gemma_tool_round_trip',
      agent: new LlmAgent({
        name: 'weather',
        model: new LiteLlm({
          model: gemmaModel!,
          apiBase,
          apiKey: process.env['LITELLM_API_KEY'],
        }),
        instruction: 'Answer using the tool, then stop.',
        tools: [getWeather],
      }),
    });
    const session = await runner.sessionService.createSession({
      appName: 'gemma_tool_round_trip',
      userId: 'user',
    });

    let answer = '';
    for await (const event of runner.runAsync({
      userId: 'user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [{text: 'What is the weather in Paris?'}],
      },
    })) {
      for (const part of event.content?.parts ?? []) {
        if (event.content?.role === 'model' && part.text) {
          answer += part.text;
        }
      }
    }

    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(MAX_TOOL_ROUND_TRIP_CALLS);
    expect(answer).toBeTruthy();
  });
});
