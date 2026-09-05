/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports the reference test of adk-python
 * `tests/integration/models/test_gemma_llm.py` (branch `main`).
 *
 * The reference calls a live Gemma endpoint. adk-js integration tests call no
 * live model, so this drives the same code path against a mocked
 * `GoogleGenAI` client and asserts the whole round trip: what the transport
 * receives, and what the caller gets back.
 */

import {Gemma, LlmRequest, LlmResponse} from '@google/adk';
import {
  GenerateContentParameters,
  GenerateContentResponse,
  Tool,
  Type,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {generateContent} = vi.hoisted(() => ({
  generateContent:
    vi.fn<
      (params: GenerateContentParameters) => Promise<GenerateContentResponse>
    >(),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {generateContent, generateContentStream: vi.fn()},
      vertexai: false,
    })),
  };
});

const DEFAULT_GEMMA_MODEL = 'gemma-3-1b-it';

function gemmaRequest(): LlmRequest {
  const tool: Tool = {
    functionDeclarations: [
      {
        name: 'search_web',
        description: 'Search the web for a query.',
        parameters: {
          type: Type.OBJECT,
          properties: {query: {type: Type.STRING}},
          required: ['query'],
        },
      },
    ],
  };

  return {
    model: DEFAULT_GEMMA_MODEL,
    contents: [{role: 'user', parts: [{text: 'What is new in ADK?'}]}],
    config: {
      temperature: 0.1,
      systemInstruction: 'Talk like a pirate.',
      tools: [tool],
    },
    liveConnectConfig: {},
    toolsDict: {},
  };
}

function textCandidate(text: string): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [{content: {role: 'model', parts: [{text}]}}];
  return response;
}

async function run(gemma: Gemma, request: LlmRequest): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of gemma.generateContentAsync(request)) {
    responses.push(response);
  }
  return responses;
}

describe('Gemma integration', () => {
  beforeEach(() => {
    generateContent.mockReset();
  });

  it('test_generate_content_async', async () => {
    generateContent.mockResolvedValue(
      textCandidate(
        '{"name": "search_web", "parameters": {"query": "ADK release notes"}}',
      ),
    );
    const gemma = new Gemma({model: DEFAULT_GEMMA_MODEL, apiKey: 'test-key'});
    const request = gemmaRequest();

    const responses = await run(gemma, request);

    const sent = generateContent.mock.calls[0][0];
    expect(sent.model).toBe(DEFAULT_GEMMA_MODEL);
    // Gemma 3 has no function calling, so the tools reach it as prompt text.
    expect(sent.config?.tools).toEqual([]);
    expect(sent.config?.systemInstruction).toBeUndefined();
    expect(sent.contents).toBe(request.contents);

    expect(request.contents[0].role).toBe('user');
    const leadingText = request.contents[0].parts?.[0].text;
    expect(leadingText).toContain('Talk like a pirate.');
    expect(leadingText).toContain('You have access to the following functions');
    expect(request.contents[1].parts?.[0].text).toBe('What is new in ADK?');

    expect(responses).toHaveLength(1);
    const parts = responses[0].content?.parts;
    expect(parts).toHaveLength(1);
    expect(parts?.[0].functionCall).toEqual({
      name: 'search_web',
      args: {query: 'ADK release notes'},
    });
    expect(parts?.[0].text).toBeUndefined();
  });

  it('returns the model text when it calls no function', async () => {
    generateContent.mockResolvedValue(
      textCandidate('Arr, nothing new, matey.'),
    );
    const gemma = new Gemma({model: DEFAULT_GEMMA_MODEL, apiKey: 'test-key'});

    const responses = await run(gemma, gemmaRequest());

    expect(responses[0].content?.parts?.[0].text).toBe(
      'Arr, nothing new, matey.',
    );
  });
});
