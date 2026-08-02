/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  Context,
  createSession,
  ExampleStoreClient,
  ExampleTool,
  InvocationContext,
  isBaseExampleProvider,
  LlmAgent,
  LlmRequest,
  PluginManager,
  VertexAiExampleStore,
} from '@google/adk';
import {Content} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';

// The v1beta1 wire shapes are deliberately not part of the public API, so the
// fixtures below reach for them by path.
import {
  SearchExamplesResponse,
  SimilarExample,
} from '../../src/examples/vertex_ai_example_store.js';

const STORE_NAME = 'projects/p/locations/us-central1/exampleStores/s';
const SEARCH_EXAMPLES_URL =
  'https://us-central1-aiplatform.googleapis.com/v1beta1/' +
  'projects/p/locations/us-central1/exampleStores/s:searchExamples';

function similarExample(options: {
  similarityScore: number;
  searchKey: string;
  expectedContents: Content[];
}): SimilarExample {
  return {
    similarityScore: options.similarityScore,
    example: {
      storedContentsExample: {
        searchKey: options.searchKey,
        contentsExample: {
          expectedContents: options.expectedContents.map((content) => ({
            content,
          })),
        },
      },
    },
  };
}

const PASSWORD_RESET_RESPONSE: SearchExamplesResponse = {
  results: [
    similarExample({
      similarityScore: 0.9,
      searchKey: 'how do I reset my password',
      expectedContents: [
        {role: 'model', parts: [{text: 'Use the reset link.'}]},
      ],
    }),
  ],
};

function fakeClient(response: SearchExamplesResponse) {
  return {
    searchExamples: vi.fn<ExampleStoreClient['searchExamples']>(
      async () => response,
    ),
  };
}

function storeWith(response: SearchExamplesResponse): VertexAiExampleStore {
  return new VertexAiExampleStore({
    examplesStoreName: STORE_NAME,
    client: fakeClient(response),
  });
}

function makeLlmRequest(model?: string): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    config: {},
    model,
  };
}

function makeContext(userContent: Content): Context {
  const session = createSession({id: 'test-session', appName: 'test-app'});
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session,
    pluginManager: new PluginManager([]),
    userContent,
  });
  return new Context({invocationContext});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VertexAiExampleStore', () => {
  it('maps search results to examples', async () => {
    const store = storeWith(PASSWORD_RESET_RESPONSE);

    expect(await store.getExamples('reset password')).toEqual([
      {
        input: {role: 'user', parts: [{text: 'how do I reset my password'}]},
        output: [{role: 'model', parts: [{text: 'Use the reset link.'}]}],
      },
    ]);
  });

  it('maps a functionCall part', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'find cats',
          expectedContents: [
            {
              role: 'model',
              parts: [{functionCall: {name: 'search', args: {q: 'cats'}}}],
            },
          ],
        }),
      ],
    });

    const [example] = await store.getExamples('find cats');

    expect(example.output).toEqual([
      {
        role: 'model',
        parts: [{functionCall: {name: 'search', args: {q: 'cats'}}}],
      },
    ]);
  });

  it('maps a functionResponse part', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'find cats',
          expectedContents: [
            {
              role: 'user',
              parts: [
                {functionResponse: {name: 'search', response: {hits: 3}}},
              ],
            },
          ],
        }),
      ],
    });

    const [example] = await store.getExamples('find cats');

    expect(example.output).toEqual([
      {
        role: 'user',
        parts: [{functionResponse: {name: 'search', response: {hits: 3}}}],
      },
    ]);
  });

  it('drops parts of an unsupported kind', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'show me a chart',
          expectedContents: [
            {
              role: 'model',
              parts: [{inlineData: {mimeType: 'image/png', data: 'AAAA'}}],
            },
          ],
        }),
      ],
    });

    const [example] = await store.getExamples('show me a chart');

    expect(example.output).toEqual([{role: 'model', parts: []}]);
  });

  it('maps a content without parts to an empty parts list', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'empty turn',
          expectedContents: [{role: 'model'}],
        }),
      ],
    });

    const [example] = await store.getExamples('empty turn');

    expect(example.output).toEqual([{role: 'model', parts: []}]);
  });

  it('preserves the order of multi-step expected contents', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'find cats',
          expectedContents: [
            {
              role: 'model',
              parts: [{functionCall: {name: 'search', args: {q: 'cats'}}}],
            },
            {role: 'model', parts: [{text: 'Found cats!'}]},
          ],
        }),
      ],
    });

    const [example] = await store.getExamples('find cats');

    expect(example.output).toEqual([
      {
        role: 'model',
        parts: [{functionCall: {name: 'search', args: {q: 'cats'}}}],
      },
      {role: 'model', parts: [{text: 'Found cats!'}]},
    ]);
  });

  it('drops results below the similarity floor and keeps results on it', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.49,
          searchKey: 'below the floor',
          expectedContents: [{role: 'model', parts: [{text: 'dropped'}]}],
        }),
        similarExample({
          similarityScore: 0.5,
          searchKey: 'on the floor',
          expectedContents: [{role: 'model', parts: [{text: 'kept'}]}],
        }),
      ],
    });

    const examples = await store.getExamples('anything');

    expect(examples).toEqual([
      {
        input: {role: 'user', parts: [{text: 'on the floor'}]},
        output: [{role: 'model', parts: [{text: 'kept'}]}],
      },
    ]);
  });

  it('drops a result whose similarity score is omitted', async () => {
    const store = storeWith({
      results: [
        {
          example: {
            storedContentsExample: {
              searchKey: 'no score',
              contentsExample: {expectedContents: []},
            },
          },
        },
      ],
    });

    expect(await store.getExamples('anything')).toEqual([]);
  });

  it('maps a result whose searchKey and contentsExample are omitted', async () => {
    const store = storeWith({
      results: [{similarityScore: 0.9, example: {storedContentsExample: {}}}],
    });

    expect(await store.getExamples('anything')).toEqual([
      {input: {role: 'user', parts: [{text: ''}]}, output: []},
    ]);
  });

  it('maps a result whose expectedContents is omitted', async () => {
    const store = storeWith({
      results: [
        {
          similarityScore: 0.9,
          example: {
            storedContentsExample: {
              searchKey: 'no contents',
              contentsExample: {},
            },
          },
        },
      ],
    });

    expect(await store.getExamples('anything')).toEqual([
      {input: {role: 'user', parts: [{text: 'no contents'}]}, output: []},
    ]);
  });

  it('returns no examples for an empty result set', async () => {
    const store = storeWith({results: []});

    expect(await store.getExamples('anything')).toEqual([]);
  });

  it('returns no examples when results are absent', async () => {
    const store = storeWith({});

    expect(await store.getExamples('anything')).toEqual([]);
  });

  it('propagates a client failure instead of returning no examples', async () => {
    const client: ExampleStoreClient = {
      searchExamples: vi.fn<ExampleStoreClient['searchExamples']>(async () => {
        throw new Error('boom');
      }),
    };
    const store = new VertexAiExampleStore({
      examplesStoreName: STORE_NAME,
      client,
    });

    await expect(store.getExamples('anything')).rejects.toThrow('boom');
  });

  it('searches with the query as the content search key', async () => {
    const client = fakeClient(PASSWORD_RESET_RESPONSE);
    const store = new VertexAiExampleStore({
      examplesStoreName: STORE_NAME,
      client,
    });

    await store.getExamples('reset password');

    expect(client.searchExamples).toHaveBeenCalledWith({
      exampleStore: STORE_NAME,
      topK: 10,
      storedContentsExampleParameters: {
        contentSearchKey: {
          contents: [{role: 'user', parts: [{text: 'reset password'}]}],
          searchKeyGenerationMethod: {lastEntry: {}},
        },
      },
    });
  });

  it('is recognised as an example provider', () => {
    expect(isBaseExampleProvider(storeWith({}))).toBe(true);
  });

  it.each([
    ['not-a-resource-name'],
    ['projects/p/locations/l'],
    ['projects/p/locations/l/exampleStores/s/extra'],
  ])('rejects the malformed store name %s', (examplesStoreName) => {
    expect(() => new VertexAiExampleStore({examplesStoreName})).toThrow(
      'examplesStoreName',
    );
  });

  it('feeds the fetched examples into an ExampleTool system instruction', async () => {
    const tool = new ExampleTool(storeWith(PASSWORD_RESET_RESPONSE));
    const llmRequest = makeLlmRequest('gemini-2.0-flash');

    await tool.processLlmRequest({
      toolContext: makeContext({
        role: 'user',
        parts: [{text: 'reset password'}],
      }),
      llmRequest,
    });

    const instruction = llmRequest.config?.systemInstruction;
    expect(instruction).toContain('<EXAMPLES>');
    expect(instruction).toContain('how do I reset my password');
    expect(instruction).toContain('Use the reset link.');
  });
});

describe('VertexAiExampleStore default REST client', () => {
  it('posts to the regional searchExamples endpoint', async () => {
    const request = vi.spyOn(GoogleAuth.prototype, 'request').mockResolvedValue(
      Object.assign(new Response(null, {status: 200, statusText: 'OK'}), {
        config: {url: new URL(SEARCH_EXAMPLES_URL), headers: new Headers()},
        data: PASSWORD_RESET_RESPONSE,
      }),
    );
    const store = new VertexAiExampleStore({examplesStoreName: STORE_NAME});

    const examples = await store.getExamples('reset password');

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({method: 'POST', url: SEARCH_EXAMPLES_URL}),
    );
    expect(examples).toEqual([
      {
        input: {role: 'user', parts: [{text: 'how do I reset my password'}]},
        output: [{role: 'model', parts: [{text: 'Use the reset link.'}]}],
      },
    ]);
  });
});
