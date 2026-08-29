/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {
  resolveRagLocation,
  retrieveRagContexts,
  toRagResources,
  toRagRetrievalConfig,
} from '../../src/tools/vertex_rag_retrieval_client.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: async () => ({
      getRequestHeaders: async () =>
        new Headers({authorization: 'Bearer fake-token'}),
    }),
  })),
}));

const RAG_CORPUS =
  'projects/my-project/locations/us-central1/ragCorpora/my-corpus';

const RETRIEVE_URL =
  'https://us-central1-aiplatform.googleapis.com/v1' +
  '/projects/my-project/locations/us-central1:retrieveContexts';

const UNRESOLVED_LOCATION_ERROR =
  'Vertex AI RAG retrieval could not resolve the project and location.';

describe('toRagResources', () => {
  it('passes configured rag resources through', () => {
    const ragResources = [{ragCorpus: RAG_CORPUS, ragFileIds: ['file-1']}];

    expect(toRagResources({ragResources})).toEqual(ragResources);
  });

  it('lifts a deprecated corpus name into a rag resource', () => {
    expect(toRagResources({ragCorpora: [RAG_CORPUS]})).toEqual([
      {ragCorpus: RAG_CORPUS},
    ]);
  });

  it('falls back to the corpus names when rag resources are empty', () => {
    expect(
      toRagResources({ragResources: [], ragCorpora: [RAG_CORPUS]}),
    ).toEqual([{ragCorpus: RAG_CORPUS}]);
  });

  it('returns nothing when the store names no corpus', () => {
    expect(toRagResources({})).toEqual([]);
  });
});

describe('resolveRagLocation', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the project and the location off the corpus name', () => {
    expect(resolveRagLocation([{ragCorpus: RAG_CORPUS}])).toEqual({
      project: 'my-project',
      location: 'us-central1',
    });
  });

  it('skips a resource that names no corpus', () => {
    expect(
      resolveRagLocation([{ragFileIds: ['file-1']}, {ragCorpus: RAG_CORPUS}]),
    ).toEqual({project: 'my-project', location: 'us-central1'});
  });

  it('falls back to the environment for a bare corpus name', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');

    expect(resolveRagLocation([{ragCorpus: 'my-corpus'}])).toEqual({
      project: 'env-project',
      location: 'europe-west4',
    });
  });

  it('rejects a bare corpus name when the environment names no project', () => {
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');

    expect(() => resolveRagLocation([{ragCorpus: 'my-corpus'}])).toThrow(
      UNRESOLVED_LOCATION_ERROR,
    );
  });

  it('rejects a bare corpus name when the environment names no location', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');

    expect(() => resolveRagLocation([{ragCorpus: 'my-corpus'}])).toThrow(
      UNRESOLVED_LOCATION_ERROR,
    );
  });
});

describe('toRagRetrievalConfig', () => {
  it('prefers an explicit retrieval config', () => {
    const ragRetrievalConfig = {topK: 3, filter: {metadataFilter: 'a = 1'}};

    expect(
      toRagRetrievalConfig({ragRetrievalConfig, similarityTopK: 99}),
    ).toEqual(ragRetrievalConfig);
  });

  it('translates the legacy top-k and distance fields', () => {
    expect(
      toRagRetrievalConfig({similarityTopK: 5, vectorDistanceThreshold: 0.5}),
    ).toEqual({topK: 5, filter: {vectorDistanceThreshold: 0.5}});
  });

  it('translates the legacy top-k on its own', () => {
    expect(toRagRetrievalConfig({similarityTopK: 5})).toEqual({topK: 5});
  });

  it('translates the legacy distance threshold on its own', () => {
    expect(toRagRetrievalConfig({vectorDistanceThreshold: 0.5})).toEqual({
      filter: {vectorDistanceThreshold: 0.5},
    });
  });

  it('returns nothing when the store configures no retrieval', () => {
    expect(toRagRetrievalConfig({ragCorpora: [RAG_CORPUS]})).toBeUndefined();
  });
});

describe('retrieveRagContexts', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the query to the corpus location, with credentials', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({contexts: {contexts: [{text: 'chunk'}]}}), {
        status: 200,
      }),
    );

    const contexts = await retrieveRagContexts({
      query: 'how do I ship it',
      vertexRagStore: {
        ragResources: [{ragCorpus: RAG_CORPUS}],
        similarityTopK: 4,
      },
    });

    expect(contexts).toEqual([{text: 'chunk'}]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RETRIEVE_URL);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer fake-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      vertexRagStore: {ragResources: [{ragCorpus: RAG_CORPUS}]},
      query: {text: 'how do I ship it', ragRetrievalConfig: {topK: 4}},
    });
  });

  it('resolves an empty list when nothing matches', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({contexts: {}}), {status: 200}),
    );

    const contexts = await retrieveRagContexts({
      query: 'nothing matches this',
      vertexRagStore: {ragCorpora: [RAG_CORPUS]},
    });

    expect(contexts).toEqual([]);
  });

  it('reports the status and the body of a failed call', async () => {
    fetchMock.mockResolvedValue(
      new Response('permission denied', {status: 403}),
    );

    await expect(
      retrieveRagContexts({
        query: 'how do I ship it',
        vertexRagStore: {ragCorpora: [RAG_CORPUS]},
      }),
    ).rejects.toThrow(
      'Vertex AI RAG retrieval failed with status 403: permission denied',
    );
  });

  it('rejects a store that names no corpus, without calling out', async () => {
    await expect(
      retrieveRagContexts({query: 'how do I ship it', vertexRagStore: {}}),
    ).rejects.toThrow(
      'Vertex AI RAG retrieval requires ragResources or ragCorpora.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
