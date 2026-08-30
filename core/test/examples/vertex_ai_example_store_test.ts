/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  Context,
  createSession,
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

/** Stubs the authenticated transport so no credentials are needed. */
function mockSearchExamples(data: SearchExamplesResponse) {
  return vi.spyOn(GoogleAuth.prototype, 'request').mockResolvedValue(
    Object.assign(new Response(null, {status: 200, statusText: 'OK'}), {
      config: {url: new URL(SEARCH_EXAMPLES_URL), headers: new Headers()},
      data,
    }),
  );
}

function storeWith(response: SearchExamplesResponse): VertexAiExampleStore {
  mockSearchExamples(response);
  return new VertexAiExampleStore(STORE_NAME);
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

  it('maps a functionResponse part without stamping an id', async () => {
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
    expect(example.output[0].parts?.[0].functionResponse?.id).toBeUndefined();
  });

  it('defaults omitted functionCall args and functionResponse response to an empty object', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'find cats',
          expectedContents: [
            {role: 'model', parts: [{functionCall: {name: 'search'}}]},
            {role: 'user', parts: [{functionResponse: {name: 'search'}}]},
          ],
        }),
      ],
    });

    const [example] = await store.getExamples('find cats');

    expect(example.output).toEqual([
      {role: 'model', parts: [{functionCall: {name: 'search', args: {}}}]},
      {
        role: 'user',
        parts: [{functionResponse: {name: 'search', response: {}}}],
      },
    ]);
  });

  it('defaults an omitted functionCall name to an empty string', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'find cats',
          expectedContents: [{role: 'model', parts: [{functionCall: {}}]}],
        }),
      ],
    });

    const [example] = await store.getExamples('find cats');

    expect(example.output).toEqual([
      {role: 'model', parts: [{functionCall: {name: '', args: {}}}]},
    ]);
  });

  it('keeps only the text of a part that also carries a functionCall', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'find cats',
          expectedContents: [
            {
              role: 'model',
              parts: [
                {
                  text: 'Searching now.',
                  functionCall: {name: 'search', args: {q: 'cats'}},
                },
              ],
            },
          ],
        }),
      ],
    });

    const [example] = await store.getExamples('find cats');

    expect(example.output).toEqual([
      {role: 'model', parts: [{text: 'Searching now.'}]},
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

  it('drops a part whose text is empty', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'say something',
          expectedContents: [
            {role: 'model', parts: [{text: ''}, {text: 'Something.'}]},
          ],
        }),
      ],
    });

    const [example] = await store.getExamples('say something');

    expect(example.output).toEqual([
      {role: 'model', parts: [{text: 'Something.'}]},
    ]);
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

  it('preserves a content role that is omitted', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.9,
          searchKey: 'no role',
          expectedContents: [{parts: [{text: 'answer'}]}],
        }),
      ],
    });

    const [example] = await store.getExamples('no role');

    expect(example.output).toEqual([
      {role: undefined, parts: [{text: 'answer'}]},
    ]);
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

  // The lower score comes first, so a mutation that sorts or reverses the
  // surviving results fails here.
  it('returns the surviving results in response order', async () => {
    const store = storeWith({
      results: [
        similarExample({
          similarityScore: 0.6,
          searchKey: 'first',
          expectedContents: [{role: 'model', parts: [{text: 'one'}]}],
        }),
        similarExample({
          similarityScore: 0.9,
          searchKey: 'second',
          expectedContents: [{role: 'model', parts: [{text: 'two'}]}],
        }),
      ],
    });

    const examples = await store.getExamples('anything');

    expect(examples.map((example) => example.input.parts?.[0].text)).toEqual([
      'first',
      'second',
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

  it('maps a result carrying another example oneof variant', async () => {
    const store = storeWith({results: [{similarityScore: 0.9, example: {}}]});

    expect(await store.getExamples('anything')).toEqual([
      {input: {role: 'user', parts: [{text: ''}]}, output: []},
    ]);
  });

  it('maps a result whose example is omitted', async () => {
    const store = storeWith({results: [{similarityScore: 0.9}]});

    expect(await store.getExamples('anything')).toEqual([
      {input: {role: 'user', parts: [{text: ''}]}, output: []},
    ]);
  });

  it('maps an expected content that is omitted', async () => {
    const store = storeWith({
      results: [
        {
          similarityScore: 0.9,
          example: {
            storedContentsExample: {
              searchKey: 'empty entry',
              contentsExample: {expectedContents: [{}]},
            },
          },
        },
      ],
    });

    expect(await store.getExamples('anything')).toEqual([
      {
        input: {role: 'user', parts: [{text: 'empty entry'}]},
        output: [{role: undefined, parts: []}],
      },
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

  it('posts the search to the regional endpoint once per call', async () => {
    const request = mockSearchExamples(PASSWORD_RESET_RESPONSE);
    const store = new VertexAiExampleStore(STORE_NAME);

    await store.getExamples('reset password');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      url: SEARCH_EXAMPLES_URL,
      method: 'POST',
      data: {
        topK: 10,
        storedContentsExampleParameters: {
          contentSearchKey: {
            contents: [{role: 'user', parts: [{text: 'reset password'}]}],
            searchKeyGenerationMethod: {lastEntry: {}},
          },
        },
      },
    });
  });

  it('addresses the endpoint of the region named in the store resource', async () => {
    const request = mockSearchExamples({results: []});
    const store = new VertexAiExampleStore(
      'projects/p/locations/europe-west4/exampleStores/s',
    );

    await store.getExamples('anything');

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url:
          'https://europe-west4-aiplatform.googleapis.com/v1beta1/' +
          'projects/p/locations/europe-west4/exampleStores/s:searchExamples',
      }),
    );
  });

  it('addresses the unprefixed host for the global location', async () => {
    const request = mockSearchExamples({results: []});
    const store = new VertexAiExampleStore(
      'projects/p/locations/global/exampleStores/s',
    );

    await store.getExamples('anything');

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url:
          'https://aiplatform.googleapis.com/v1beta1/' +
          'projects/p/locations/global/exampleStores/s:searchExamples',
      }),
    );
  });

  it('propagates a failed search instead of returning no examples', async () => {
    vi.spyOn(GoogleAuth.prototype, 'request').mockRejectedValue(
      new Error('Request failed with status code 403'),
    );
    const store = new VertexAiExampleStore(STORE_NAME);

    await expect(store.getExamples('anything')).rejects.toThrow('403');
  });

  it('is recognised as an example provider', () => {
    expect(isBaseExampleProvider(storeWith({}))).toBe(true);
  });

  it.each([
    ['not-a-resource-name'],
    ['projects/p/locations/l'],
    ['projects/p/locations/l/exampleStores/s/extra'],
  ])('rejects the malformed store name %s', (examplesStoreName) => {
    const request = mockSearchExamples({});

    expect(() => new VertexAiExampleStore(examplesStoreName)).toThrow(
      'examplesStoreName',
    );
    expect(request).not.toHaveBeenCalled();
  });

  // The location is spliced into the request host, and the search carries an
  // ADC bearer token. A name that moves the host would send that token to
  // another origin, so each of these must be rejected before any request.
  it.each([
    ['projects/p/locations/attacker.example?/exampleStores/s'],
    ['projects/p/locations/attacker.example#/exampleStores/s'],
    ['projects/p/locations/x@attacker.example/exampleStores/s'],
  ])('rejects the store name %s, which would move the request host', (name) => {
    const request = mockSearchExamples({});

    expect(() => new VertexAiExampleStore(name)).toThrow('examplesStoreName');
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts a region name that is not the default', () => {
    expect(
      () =>
        new VertexAiExampleStore(
          'projects/my_proj-1/locations/asia-northeast1/exampleStores/store_A-1',
        ),
    ).not.toThrow();
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
