/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EmbedContentClient,
  GeminiEmbeddingModel,
  getDefaultEmbeddingModel,
} from '@google/adk';
import {createDefaultEmbedContentClient} from '@google/adk/tools/retrieval/embedding_model.js';
import {
  ContentEmbedding,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import {afterEach, describe, expect, it} from 'vitest';

const ENTERPRISE_MODE_ENV_VAR = 'GOOGLE_GENAI_USE_ENTERPRISE';
const API_KEY_ENV_VAR = 'GOOGLE_API_KEY';

describe('createDefaultEmbedContentClient', () => {
  const originalEnv = {...process.env};

  afterEach(() => {
    process.env = {...originalEnv};
  });

  it('builds a Gemini API client by default', () => {
    delete process.env[ENTERPRISE_MODE_ENV_VAR];
    // The client warns when it finds no key, and the warning is not the
    // subject of this test.
    process.env[API_KEY_ENV_VAR] = 'placeholder-api-key';

    expect(createDefaultEmbedContentClient().vertexai).toBe(false);
  });

  it('builds a Vertex AI client in enterprise mode', () => {
    process.env[ENTERPRISE_MODE_ENV_VAR] = '1';

    expect(createDefaultEmbedContentClient().vertexai).toBe(true);
  });
});

/** Number of texts a `contents` value holds, which is a string or an array. */
function countContents(contents: EmbedContentParameters['contents']): number {
  return Array.isArray(contents) ? contents.length : 1;
}

function makeResponse(embeddings?: ContentEmbedding[]): EmbedContentResponse {
  const response = new EmbedContentResponse();
  response.embeddings = embeddings;
  return response;
}

/**
 * A client that answers with one vector per input text and records the calls.
 *
 * `missingEmbeddings` drops that many vectors from every response, which is
 * how the count-mismatch path is exercised without a live API.
 */
class FakeEmbedContentClient implements EmbedContentClient {
  readonly calls: EmbedContentParameters[] = [];
  readonly models: EmbedContentClient['models'];

  constructor(private readonly missingEmbeddings = 0) {
    this.models = {
      embedContent: async (params: EmbedContentParameters) => {
        this.calls.push(params);
        const count = countContents(params.contents) - this.missingEmbeddings;
        const embeddings: ContentEmbedding[] = [];
        for (let index = 0; index < count; index++) {
          embeddings.push({values: [index, this.calls.length]});
        }
        return makeResponse(embeddings);
      },
    };
  }
}

describe('getDefaultEmbeddingModel', () => {
  it('uses the model and the batch size adk-python defaults to', () => {
    const model = getDefaultEmbeddingModel();

    expect(model.model).toBe('gemini-embedding-2-preview');
    expect(model.embedBatchSize).toBe(1);
  });
});

describe('GeminiEmbeddingModel', () => {
  it('sends one text per call at the default batch size', async () => {
    const client = new FakeEmbedContentClient();
    const model = new GeminiEmbeddingModel({client});

    const embeddings = await model.embedDocuments(['one', 'two', 'three']);

    expect(client.calls.map((call) => call.contents)).toEqual([
      ['one'],
      ['two'],
      ['three'],
    ]);
    expect(embeddings).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
  });

  it('groups the texts into batches of embedBatchSize', async () => {
    const client = new FakeEmbedContentClient();
    const model = new GeminiEmbeddingModel({client, embedBatchSize: 2});

    const embeddings = await model.embedDocuments(['one', 'two', 'three']);

    expect(client.calls.map((call) => call.contents)).toEqual([
      ['one', 'two'],
      ['three'],
    ]);
    expect(embeddings).toHaveLength(3);
  });

  it('keeps the input order when the batches finish out of order', async () => {
    const client = new FakeEmbedContentClient();
    const model = new GeminiEmbeddingModel({client, embedBatchSize: 1});

    const embeddings = await model.embedDocuments(['one', 'two']);

    // The second element of each vector is the call number the fake answered.
    expect(embeddings).toEqual([
      [0, 1],
      [0, 2],
    ]);
  });

  it('embeds documents with the document task type', async () => {
    const client = new FakeEmbedContentClient();
    const model = new GeminiEmbeddingModel({client, model: 'test-embedding'});

    await model.embedDocuments(['one']);

    expect(client.calls[0]).toEqual({
      model: 'test-embedding',
      contents: ['one'],
      config: {taskType: 'RETRIEVAL_DOCUMENT'},
    });
  });

  it('embeds a query with the query task type', async () => {
    const client = new FakeEmbedContentClient();
    const model = new GeminiEmbeddingModel({client});

    const embedding = await model.embedQuery('what is retrieval');

    expect(client.calls[0].config).toEqual({taskType: 'RETRIEVAL_QUERY'});
    expect(client.calls[0].contents).toEqual(['what is retrieval']);
    expect(embedding).toEqual([0, 1]);
  });

  it('rejects a response that returns fewer embeddings than inputs', async () => {
    const client = new FakeEmbedContentClient(1);
    const model = new GeminiEmbeddingModel({client, embedBatchSize: 2});

    await expect(model.embedDocuments(['one', 'two'])).rejects.toThrow(
      'Embedding model gemini-embedding-2-preview returned 1 embeddings for ' +
        '2 inputs.',
    );
  });

  it('rejects a response whose embedding carries no values', async () => {
    const client: EmbedContentClient = {
      models: {
        embedContent: async () => makeResponse([{}]),
      },
    };
    const model = new GeminiEmbeddingModel({client});

    await expect(model.embedQuery('one')).rejects.toThrow(
      'returned 0 embeddings for 1 inputs.',
    );
  });

  it('rejects a response that carries no embeddings at all', async () => {
    const client: EmbedContentClient = {
      models: {
        embedContent: async () => makeResponse(),
      },
    };
    const model = new GeminiEmbeddingModel({client});

    await expect(model.embedQuery('one')).rejects.toThrow(
      'returned 0 embeddings for 1 inputs.',
    );
  });
});
