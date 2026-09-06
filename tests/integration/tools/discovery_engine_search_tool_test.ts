/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DiscoveryEngineSearchTool, InMemoryRunner, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {GeminiWithMockResponses} from '../test_case_utils.js';

// A stand-in for Application Default Credentials, so the test resolves none.
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: () =>
      Promise.resolve({
        getRequestHeaders: () =>
          Promise.resolve(new Headers({authorization: 'Bearer fake-token'})),
      }),
  })),
}));

/** The single hit the stubbed Discovery Engine endpoint returns. */
const SEARCH_RESULT = {
  chunk: {
    content: 'ADK ships an agent runtime for TypeScript.',
    documentMetadata: {title: 'About ADK', uri: 'https://example.com/adk'},
  },
};

describe('DiscoveryEngineSearchTool Integration', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({results: [SEARCH_RESULT]}), {status: 200}),
      );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers the model with the search results of a data store', async () => {
    const agent = new LlmAgent({
      name: 'search_agent',
      description: 'Answers questions from a Vertex AI Search data store.',
      instruction: 'Answer questions using the data store.',
      tools: [
        new DiscoveryEngineSearchTool({
          dataStoreId:
            'projects/test/locations/eu/collections/default_collection/' +
            'dataStores/docs',
        }),
      ],
    });
    agent.model = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'discovery_engine_search',
                    args: {query: 'what is adk'},
                  },
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
              parts: [{text: 'ADK is an agent runtime for TypeScript.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({agent, appName: 'search_app'});
    const session = await runner.sessionService.createSession({
      appName: 'search_app',
      userId: 'test_user',
    });

    let finalResponse = '';
    let toolResponse: unknown;
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('What is ADK?'),
    })) {
      const part = event.content?.parts?.[0];
      if (part?.functionResponse?.name === 'discovery_engine_search') {
        toolResponse = part.functionResponse.response;
      }
      if (event.author === 'search_agent' && part?.text) {
        finalResponse += part.text;
      }
    }

    expect(toolResponse).toEqual({
      status: 'success',
      results: [
        {
          title: 'About ADK',
          url: 'https://example.com/adk',
          content: 'ADK ships an agent runtime for TypeScript.',
        },
      ],
    });
    expect(finalResponse).toBe('ADK is an agent runtime for TypeScript.');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://eu-discoveryengine.googleapis.com/v1beta/projects/test/' +
        'locations/eu/collections/default_collection/dataStores/docs/' +
        'servingConfigs/default_config:search',
    );
  });
});
