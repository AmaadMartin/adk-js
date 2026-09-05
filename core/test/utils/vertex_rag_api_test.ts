/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {VertexRagApiClient} from '../../src/utils/vertex_rag_api.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        getRequestHeaders: async () =>
          new Headers({authorization: 'Bearer test-token'}),
      };
    }
  },
}));

const HOST = 'https://us-central1-aiplatform.googleapis.com';
const CORPUS = 'projects/test-project/locations/us-central1/ragCorpora/1';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {status});
}

/** Reads back one stubbed `fetch` call, without weakening its types. */
function requestOf(fetchMock: Mock<typeof fetch>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index];
  if (typeof url !== 'string') {
    expect.fail('fetch was not called with a url string');
  }
  if (!init) {
    expect.fail('fetch was called without a request init');
  }
  if (!(init.headers instanceof Headers)) {
    expect.fail('fetch was called without a Headers instance');
  }
  return {url, init, headers: init.headers};
}

describe('VertexRagApiClient', () => {
  let fetchMock: Mock<typeof fetch>;
  let client: VertexRagApiClient;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    client = new VertexRagApiClient({location: 'us-central1'});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('listRagFiles', () => {
    it('requests one page and returns it', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ragFiles: [{name: 'f'}], nextPageToken: 'next'}),
      );

      const response = await client.listRagFiles({
        ragCorpus: CORPUS,
        pageSize: 100,
      });

      expect(response).toEqual({
        ragFiles: [{name: 'f'}],
        nextPageToken: 'next',
      });
      const request = requestOf(fetchMock);
      expect(request.url).toBe(`${HOST}/v1/${CORPUS}/ragFiles?pageSize=100`);
      expect(request.init.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe('Bearer test-token');
    });

    it('encodes the page token into the query', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await client.listRagFiles({
        ragCorpus: CORPUS,
        pageSize: 100,
        pageToken: 'a b/c',
      });

      expect(requestOf(fetchMock).url).toBe(
        `${HOST}/v1/${CORPUS}/ragFiles?pageSize=100&pageToken=a+b%2Fc`,
      );
    });

    it('throws with the status and the body when the request fails', async () => {
      fetchMock.mockResolvedValue(
        new Response('permission denied', {status: 403}),
      );

      await expect(
        client.listRagFiles({ragCorpus: CORPUS, pageSize: 100}),
      ).rejects.toThrow(/status 403: permission denied/);
    });
  });

  describe('uploadRagFile', () => {
    it('posts the transcript as a multipart upload', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ragFile: {name: 'f'}}));

      await client.uploadRagFile({
        ragCorpus: CORPUS,
        displayName: 'adk-memory-v1.ZGVtbw.YWxpY2U.cw',
        content: 'transcript line',
      });

      const request = requestOf(fetchMock);
      expect(request.url).toBe(`${HOST}/upload/v1/${CORPUS}/ragFiles:upload`);
      expect(request.init.method).toBe('POST');
      expect(request.headers.get('X-Goog-Upload-Protocol')).toBe('multipart');
      // fetch must generate the multipart boundary itself.
      expect(request.headers.get('Content-Type')).toBeNull();

      const body = request.init.body;
      if (!(body instanceof FormData)) {
        expect.fail('the upload body is not FormData');
      }
      const metadata = body.get('metadata');
      const file = body.get('file');
      if (!(metadata instanceof Blob) || !(file instanceof Blob)) {
        expect.fail('the upload body is missing a part');
      }
      expect(JSON.parse(await metadata.text())).toEqual({
        ragFile: {displayName: 'adk-memory-v1.ZGVtbw.YWxpY2U.cw'},
        uploadRagFileConfig: {},
      });
      expect(await file.text()).toBe('transcript line');
    });

    it('throws when the upload is rejected inside a 200 response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({error: {code: 400, message: 'file too large'}}),
      );

      await expect(
        client.uploadRagFile({
          ragCorpus: CORPUS,
          displayName: 'name',
          content: 'transcript',
        }),
      ).rejects.toThrow(/rejected the uploaded file.*file too large/);
    });
  });

  describe('retrieveContexts', () => {
    it('posts the store and the query to the retrieval endpoint', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({contexts: {contexts: [{text: 'chunk'}]}}),
      );

      const response = await client.retrieveContexts({
        parent: 'projects/test-project/locations/us-central1',
        vertexRagStore: {
          ragResources: [{ragCorpus: CORPUS}],
          vectorDistanceThreshold: 10,
        },
        query: {text: 'memory', ragRetrievalConfig: {topK: 5}},
      });

      expect(response).toEqual({contexts: {contexts: [{text: 'chunk'}]}});
      const request = requestOf(fetchMock);
      expect(request.url).toBe(
        `${HOST}/v1/projects/test-project/locations/us-central1:retrieveContexts`,
      );
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(String(request.init.body))).toEqual({
        vertexRagStore: {
          ragResources: [{ragCorpus: CORPUS}],
          vectorDistanceThreshold: 10,
        },
        query: {text: 'memory', ragRetrievalConfig: {topK: 5}},
      });
    });
  });
});
