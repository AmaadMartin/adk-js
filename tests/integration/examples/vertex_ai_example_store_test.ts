/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExampleTool,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  Runner,
  VertexAiExampleStore,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

const {googleAuth, searchRequest} = vi.hoisted(() => {
  const searchRequest = vi.fn();
  return {searchRequest, googleAuth: vi.fn(() => ({request: searchRequest}))};
});

vi.mock('google-auth-library', () => ({GoogleAuth: googleAuth}));

const STORE_NAME =
  'projects/my-project/locations/us-central1/exampleStores/my-store';

function makeAgent(capture: (request: LlmRequest) => void): LlmAgent {
  const agent = new LlmAgent({
    name: 'weather_agent',
    description: 'Answers weather questions with curated examples.',
    instruction: 'Answer the question.',
    tools: [new ExampleTool(new VertexAiExampleStore(STORE_NAME))],
    beforeModelCallback: ({request}) => {
      capture(request);
      return undefined;
    },
  });
  agent.model = new GeminiWithMockResponses([
    {
      candidates: [{content: {role: 'model', parts: [{text: 'it is sunny'}]}}],
    },
  ]);
  return agent;
}

async function runOneTurn(agent: LlmAgent, query: string): Promise<void> {
  const runner = new Runner({
    appName: 'example_store_app',
    agent,
    sessionService: new InMemorySessionService(),
  });
  const session = await runner.sessionService.createSession({
    appName: 'example_store_app',
    userId: 'test_user',
  });
  for await (const _event of runner.runAsync({
    userId: 'test_user',
    sessionId: session.id,
    newMessage: createUserContent(query),
  })) {
    // Drain the stream so the turn completes.
  }
}

describe('VertexAiExampleStore integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('puts the searched examples into the system instruction', async () => {
    searchRequest.mockResolvedValue({
      data: {
        results: [
          {
            similarityScore: 0.9,
            example: {
              storedContentsExample: {
                searchKey: 'what is the weather in London?',
                contentsExample: {
                  expectedContents: [
                    {
                      content: {
                        role: 'model',
                        parts: [
                          {
                            functionCall: {
                              name: 'get_weather',
                              args: {city: 'London'},
                            },
                          },
                        ],
                      },
                    },
                    {
                      content: {role: 'model', parts: [{text: 'it is sunny'}]},
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });
    let captured: LlmRequest | undefined;

    await runOneTurn(
      makeAgent((request) => {
        captured = request;
      }),
      'what is the weather?',
    );

    const instruction = captured?.config?.systemInstruction;
    expect(instruction).toContain('<EXAMPLES>');
    expect(instruction).toContain('what is the weather in London?');
    expect(instruction).toContain("get_weather(city='London')");
    expect(searchRequest).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url:
          'https://us-central1-aiplatform.googleapis.com/v1beta1/' +
          `${STORE_NAME}:searchExamples`,
        method: 'POST',
      }),
    );
  });

  it('fails the turn when the store rejects the search', async () => {
    searchRequest.mockRejectedValue(new Error('403 permission denied'));

    await expect(
      runOneTurn(
        makeAgent(() => {}),
        'what is the weather?',
      ),
    ).rejects.toThrow('403 permission denied');
  });
});
