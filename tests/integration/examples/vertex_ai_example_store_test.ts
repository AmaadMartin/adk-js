/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExampleTool,
  InMemoryRunner,
  LlmAgent,
  VertexAiExampleStore,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {GeminiWithMockResponses} from '../test_case_utils.js';

const STORE_NAME = 'projects/p/locations/us-central1/exampleStores/s';
const SEARCH_EXAMPLES_URL =
  'https://us-central1-aiplatform.googleapis.com/v1beta1/' +
  'projects/p/locations/us-central1/exampleStores/s:searchExamples';

const SEARCH_RESPONSE = {
  results: [
    {
      similarityScore: 0.87,
      example: {
        storedContentsExample: {
          searchKey: 'how do I reset my password',
          contentsExample: {
            expectedContents: [
              {
                content: {
                  role: 'model',
                  parts: [{text: 'Open Settings and choose Reset password.'}],
                },
              },
            ],
          },
        },
      },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VertexAiExampleStore Integration', () => {
  it('renders fetched examples into the outgoing system instruction', async () => {
    const search = vi.spyOn(GoogleAuth.prototype, 'request').mockResolvedValue(
      Object.assign(new Response(null, {status: 200, statusText: 'OK'}), {
        config: {url: new URL(SEARCH_EXAMPLES_URL), headers: new Headers()},
        data: SEARCH_RESPONSE,
      }),
    );

    let capturedInstruction = '';
    const agent = new LlmAgent({
      name: 'support_agent',
      description: 'Answers account questions with few-shot examples.',
      instruction: 'Help the user with their account.',
      tools: [new ExampleTool(new VertexAiExampleStore(STORE_NAME))],
      beforeModelCallback: async ({request}) => {
        if (request.config?.systemInstruction) {
          capturedInstruction += request.config.systemInstruction.toString();
        }
        return undefined;
      },
    });
    agent.model = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Open Settings and choose Reset password.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({agent, appName: 'example_store_app'});
    const session = await runner.sessionService.createSession({
      appName: 'example_store_app',
      userId: 'test_user',
    });

    let finalResponse = '';
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('I forgot my password'),
    })) {
      if (event.author === 'support_agent') {
        finalResponse += event.content?.parts?.[0]?.text ?? '';
      }
    }

    expect(capturedInstruction).toContain('<EXAMPLES>');
    expect(capturedInstruction).toContain('how do I reset my password');
    expect(capturedInstruction).toContain(
      'Open Settings and choose Reset password.',
    );
    expect(finalResponse).toContain('Open Settings and choose Reset password.');
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        url: SEARCH_EXAMPLES_URL,
        method: 'POST',
        data: expect.objectContaining({
          topK: 10,
          storedContentsExampleParameters: {
            contentSearchKey: {
              contents: [
                {role: 'user', parts: [{text: 'I forgot my password'}]},
              ],
              searchKeyGenerationMethod: {lastEntry: {}},
            },
          },
        }),
      }),
    );
  });

  it('fails the turn when the example search fails', async () => {
    vi.spyOn(GoogleAuth.prototype, 'request').mockRejectedValue(
      new Error('Request failed with status code 403'),
    );

    const agent = new LlmAgent({
      name: 'support_agent',
      description: 'Answers account questions with few-shot examples.',
      instruction: 'Help the user with their account.',
      tools: [new ExampleTool(new VertexAiExampleStore(STORE_NAME))],
    });
    agent.model = new GeminiWithMockResponses([
      {candidates: [{content: {role: 'model', parts: [{text: 'unused'}]}}]},
    ]);

    const runner = new InMemoryRunner({agent, appName: 'example_store_app'});
    const session = await runner.sessionService.createSession({
      appName: 'example_store_app',
      userId: 'test_user',
    });

    await expect(async () => {
      for await (const _ of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent('I forgot my password'),
      })) {
        // Draining the stream surfaces the failure raised while building the
        // request.
      }
    }).rejects.toThrow('403');
  });
});
