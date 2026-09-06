/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {VertexAiExampleStore} from '@google/adk';
import {Content, Part} from '@google/genai';
import type {gaxios} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  SearchExamplesResponse,
  SimilarExample,
} from '../../src/examples/vertex_ai_example_store.js';

const {googleAuth, searchRequest} = vi.hoisted(() => {
  const searchRequest =
    vi.fn<
      (options: gaxios.GaxiosOptions) => Promise<{data: SearchExamplesResponse}>
    >();
  return {searchRequest, googleAuth: vi.fn(() => ({request: searchRequest}))};
});

vi.mock('google-auth-library', () => ({GoogleAuth: googleAuth}));

const STORE_NAME =
  'projects/my-project/locations/us-central1/exampleStores/my-store';
const SEARCH_URL =
  'https://us-central1-aiplatform.googleapis.com/v1beta1/' +
  'projects/my-project/locations/us-central1/exampleStores/my-store' +
  ':searchExamples';
const NAME_FORMAT =
  'projects/{project}/locations/{location}/exampleStores/{example_store}';

function makeResult(options: {
  score?: number;
  searchKey?: string;
  expectedContents?: Array<{content?: Content}>;
}): SimilarExample {
  return {
    similarityScore: options.score ?? 1,
    example: {
      storedContentsExample: {
        searchKey: options.searchKey ?? 'search key',
        contentsExample: {expectedContents: options.expectedContents ?? []},
      },
    },
  };
}

function makeModelContent(...parts: Part[]): {content: Content} {
  return {content: {role: 'model', parts}};
}

function respondWith(...results: SimilarExample[]): void {
  searchRequest.mockResolvedValue({data: {results}});
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith();
});

describe('VertexAiExampleStore constructor', () => {
  it('rejects a store name that is missing segments', () => {
    expect(
      () => new VertexAiExampleStore('projects/p/exampleStores/s'),
    ).toThrow(
      `Example store name projects/p/exampleStores/s is not valid. It should ` +
        `be in the format ${NAME_FORMAT}.`,
    );
  });

  it.each(['/', '?', '#', '@'])(
    'rejects a location containing %s, which relocates the request host',
    (character) => {
      const name = `projects/p/locations/us-central1${character}evil.example.com/exampleStores/s`;

      expect(() => new VertexAiExampleStore(name)).toThrow(
        `Example store name ${name} is not valid.`,
      );
    },
  );

  it('keeps the store resource name it was given', () => {
    expect(new VertexAiExampleStore(STORE_NAME).examplesStoreName).toBe(
      STORE_NAME,
    );
  });

  it('requests the cloud-platform scope for the search credentials', () => {
    new VertexAiExampleStore(STORE_NAME);

    expect(googleAuth).toHaveBeenCalledWith({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  });
});

describe('VertexAiExampleStore.getExamples', () => {
  it('posts the search to the regional endpoint once per call', async () => {
    await new VertexAiExampleStore(STORE_NAME).getExamples(
      'what is the weather?',
    );

    expect(searchRequest).toHaveBeenCalledExactlyOnceWith({
      url: SEARCH_URL,
      method: 'POST',
      data: {
        topK: 10,
        storedContentsExampleParameters: {
          contentSearchKey: {
            contents: [{role: 'user', parts: [{text: 'what is the weather?'}]}],
            searchKeyGenerationMethod: {lastEntry: {}},
          },
        },
      },
    });
  });

  it('addresses the unprefixed host for the global location', async () => {
    const name = 'projects/p/locations/global/exampleStores/s';

    await new VertexAiExampleStore(name).getExamples('query');

    expect(searchRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://aiplatform.googleapis.com/v1beta1/${name}:searchExamples`,
      }),
    );
  });

  it('returns no examples when the search matches nothing', async () => {
    respondWith();

    await expect(
      new VertexAiExampleStore(STORE_NAME).getExamples('query'),
    ).resolves.toEqual([]);
  });

  it('returns no examples when the response omits the results field', async () => {
    searchRequest.mockResolvedValue({data: {}});

    await expect(
      new VertexAiExampleStore(STORE_NAME).getExamples('query'),
    ).resolves.toEqual([]);
  });

  it('converts a text part', async () => {
    respondWith(
      makeResult({
        searchKey: 'what is the weather?',
        expectedContents: [makeModelContent({text: 'it is sunny'})],
      }),
    );

    const examples = await new VertexAiExampleStore(STORE_NAME).getExamples(
      'query',
    );

    expect(examples).toEqual([
      {
        input: {role: 'user', parts: [{text: 'what is the weather?'}]},
        output: [{role: 'model', parts: [{text: 'it is sunny'}]}],
      },
    ]);
  });

  it('converts a function call part', async () => {
    respondWith(
      makeResult({
        expectedContents: [
          makeModelContent({
            functionCall: {name: 'get_weather', args: {city: 'London'}},
          }),
        ],
      }),
    );

    const examples = await new VertexAiExampleStore(STORE_NAME).getExamples(
      'query',
    );

    expect(examples[0].output[0].parts).toEqual([
      {functionCall: {name: 'get_weather', args: {city: 'London'}}},
    ]);
  });

  it('converts a function response part without stamping an id', async () => {
    respondWith(
      makeResult({
        expectedContents: [
          makeModelContent({
            functionResponse: {
              name: 'get_weather',
              response: {temperature: 12},
            },
          }),
        ],
      }),
    );

    const examples = await new VertexAiExampleStore(STORE_NAME).getExamples(
      'query',
    );

    expect(examples[0].output[0].parts).toEqual([
      {functionResponse: {name: 'get_weather', response: {temperature: 12}}},
    ]);
  });

  it('drops a part that is neither text nor function call nor response', async () => {
    respondWith(
      makeResult({
        expectedContents: [
          makeModelContent(
            {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
            {text: 'it is sunny'},
          ),
        ],
      }),
    );

    const examples = await new VertexAiExampleStore(STORE_NAME).getExamples(
      'query',
    );

    expect(examples[0].output[0].parts).toEqual([{text: 'it is sunny'}]);
  });

  it('drops results below the similarity floor and keeps results on it', async () => {
    respondWith(
      makeResult({score: 0.49, searchKey: 'too far'}),
      makeResult({score: 0.5, searchKey: 'near enough'}),
    );

    const examples = await new VertexAiExampleStore(STORE_NAME).getExamples(
      'query',
    );

    expect(examples.map((example) => example.input.parts?.[0].text)).toEqual([
      'near enough',
    ]);
  });

  it('drops a result whose similarity score is omitted', async () => {
    respondWith({example: {storedContentsExample: {searchKey: 'unscored'}}});

    await expect(
      new VertexAiExampleStore(STORE_NAME).getExamples('query'),
    ).resolves.toEqual([]);
  });

  it('builds the input from the stored search key, not from the query', async () => {
    respondWith(makeResult({searchKey: 'stored key'}));

    const examples = await new VertexAiExampleStore(STORE_NAME).getExamples(
      'q',
    );

    expect(examples[0].input).toEqual({
      role: 'user',
      parts: [{text: 'stored key'}],
    });
  });

  it('yields an empty output when the stored example is absent', async () => {
    respondWith({similarityScore: 1});

    const examples = await new VertexAiExampleStore(STORE_NAME).getExamples(
      'query',
    );

    expect(examples).toEqual([
      {input: {role: 'user', parts: [{text: ''}]}, output: []},
    ]);
  });

  it('yields an undefined role when an expected content is absent', async () => {
    respondWith(makeResult({expectedContents: [{}]}));

    const examples = await new VertexAiExampleStore(STORE_NAME).getExamples(
      'query',
    );

    expect(examples[0].output).toEqual([{role: undefined, parts: []}]);
  });

  it('copies the function call args instead of aliasing the response', async () => {
    const args = {city: 'London'};
    const response = {temperature: 12};
    respondWith(
      makeResult({
        expectedContents: [
          makeModelContent(
            {functionCall: {name: 'get_weather', args}},
            {functionResponse: {name: 'get_weather', response}},
          ),
        ],
      }),
    );

    const parts = (
      await new VertexAiExampleStore(STORE_NAME).getExamples('query')
    )[0].output[0].parts;

    expect(parts?.[0].functionCall?.args).toEqual(args);
    expect(parts?.[0].functionCall?.args).not.toBe(args);
    expect(parts?.[1].functionResponse?.response).toEqual(response);
    expect(parts?.[1].functionResponse?.response).not.toBe(response);
  });

  it('propagates a rejection from the authenticated request', async () => {
    searchRequest.mockRejectedValue(new Error('403 permission denied'));

    await expect(
      new VertexAiExampleStore(STORE_NAME).getExamples('query'),
    ).rejects.toThrow('403 permission denied');
  });
});
