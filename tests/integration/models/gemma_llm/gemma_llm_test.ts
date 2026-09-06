/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, Gemma, LlmAgent} from '@google/adk';
import type {Candidate, UsageMetadata} from '@google/genai';
import {GenerateContentResponse, GoogleGenAI} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {createRunner} from '../../test_case_utils.js';

interface RawResponse {
  candidates?: Candidate[];
  usageMetadata?: UsageMetadata;
}

function toResponse(raw: RawResponse): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = raw.candidates;
  response.usageMetadata = raw.usageMetadata;
  return response;
}

/**
 * Builds a Gemma instance whose backend is replaced by a queue of canned
 * responses, so the full agent round-trip can be exercised without any network
 * access or credentials.
 */
function mockGemma(rawResponses: RawResponse[]): Gemma {
  const responses = rawResponses.map(toResponse);
  let index = 0;
  const next = (): GenerateContentResponse => {
    if (index >= responses.length) {
      throw new Error(
        `No more recorded responses available. Requested ${index + 1}, but` +
          ` only have ${responses.length}.`,
      );
    }
    return responses[index++];
  };

  const mockClient = {
    vertexai: false,
    models: {
      async generateContent(): Promise<GenerateContentResponse> {
        return next();
      },
      async generateContentStream(): Promise<
        AsyncGenerator<GenerateContentResponse>
      > {
        const response = next();
        return (async function* () {
          yield response;
        })();
      },
    },
  };

  const gemma = new Gemma({apiKey: 'test-key'});
  Object.defineProperty(gemma, 'apiClient', {
    get: () => mockClient as unknown as GoogleGenAI,
  });
  return gemma;
}

const getWeatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Retrieves the current weather report for a specified city.',
  parameters: z.object({
    city: z.string().describe('The name of the city.'),
  }),
  execute: async ({city}: {city: string}) => ({
    status: 'success',
    report: `The weather in ${city} is sunny and 25C.`,
  }),
});

describe('Gemma Integration (mocked backend)', () => {
  it('calls a tool end-to-end from a text-JSON function call and produces a final answer', async () => {
    // Turn 1: Gemma has no native function calling, so it replies with the
    // function call encoded as JSON text. Turn 2: after the tool result is fed
    // back, it replies with a plain-text final answer.
    const model = mockGemma([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: '{"name": "get_weather", "parameters": {"city": "New York"}}',
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'The weather in New York is sunny and 25C.'}],
            },
          },
        ],
      },
    ]);

    const agent = new LlmAgent({
      name: 'weather_agent',
      model,
      instruction: 'You are a helpful weather assistant.',
      tools: [getWeatherTool],
    });

    const runner = await createRunner(agent);

    const functionCalls = [];
    const functionResponses = [];
    let finalText = '';
    for await (const event of runner.run('What is the weather in New York?')) {
      if (event.partial) {
        continue;
      }
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
        if (part.functionResponse) {
          functionResponses.push(part.functionResponse);
        }
        if (part.text && event.content?.role === 'model') {
          finalText += part.text;
        }
      }
    }

    // The text-JSON reply was parsed into a structured function call...
    expect(functionCalls).toHaveLength(1);
    expect(functionCalls[0].name).toBe('get_weather');
    expect(functionCalls[0].args).toEqual({city: 'New York'});

    // ...the tool was actually invoked and produced a response...
    expect(functionResponses).toHaveLength(1);
    expect(functionResponses[0].name).toBe('get_weather');
    expect(functionResponses[0].response).toMatchObject({status: 'success'});

    // ...and the model produced a final natural-language answer.
    expect(finalText).toContain('The weather in New York is sunny');
  });

  it('surfaces a plain-text response without inventing a function call', async () => {
    const model = mockGemma([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Hello! How can I help you today?'}],
            },
          },
        ],
      },
    ]);

    const agent = new LlmAgent({
      name: 'chat_agent',
      model,
      instruction: 'You are a friendly assistant.',
    });

    const runner = await createRunner(agent);

    let finalText = '';
    const functionCalls = [];
    for await (const event of runner.run('Hi there')) {
      if (event.partial) {
        continue;
      }
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
        if (part.text && event.content?.role === 'model') {
          finalText += part.text;
        }
      }
    }

    expect(functionCalls).toHaveLength(0);
    expect(finalText).toContain('How can I help you');
  });
});
