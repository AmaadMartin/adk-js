/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  DiscoveryEngineSearchResult,
  DiscoveryEngineSearchTool,
  DiscoveryEngineSearchToolResult,
  SearchResultMode,
  VertexAISearchDataStoreSpec,
} from '@google/adk';
import {Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Mutable auth state controlled per test.
let mockQuotaProjectId: string | undefined;
let mockAuthorization: string | null;

vi.mock('google-auth-library', () => {
  return {
    GoogleAuth: vi.fn().mockImplementation(() => ({
      getClient: vi.fn().mockResolvedValue({
        getRequestHeaders: vi.fn().mockImplementation(async () => {
          const headers = new Headers();
          if (mockAuthorization) {
            headers.set('Authorization', mockAuthorization);
          }
          return headers;
        }),
        get quotaProjectId() {
          return mockQuotaProjectId;
        },
      }),
    })),
  };
});

const fetchMock = vi.fn<typeof fetch>();

const STRUCTURED_ERROR_TEXT =
  '`content_search_spec.search_result_mode` must be set to ' +
  'SearchRequest.ContentSearchSpec.SearchResultMode.DOCUMENTS when the ' +
  'engine contains structured data store.';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {'Content-Type': 'application/json'},
  });
}

function errorResponse(status: number, text: string): Response {
  return new Response(text, {status});
}

/** Makes every search return a fresh copy of `body`. */
function respondWith(body: unknown): void {
  fetchMock.mockImplementation(async () => okResponse(body));
}

/** The JSON body the tool posts to the Discovery Engine `:search` endpoint. */
interface SearchRequestBody {
  query?: string;
  contentSearchSpec?: {
    searchResultMode?: string;
    chunkSpec?: {numPreviousChunks: number; numNextChunks: number};
  };
  dataStoreSpecs?: VertexAISearchDataStoreSpec[];
  filter?: string;
  pageSize?: number;
}

/** Reads back the request the tool issued on its `callIndex`-th fetch. */
function capturedRequest(callIndex = 0): {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: SearchRequestBody;
} {
  const [input, init] = fetchMock.mock.calls[callIndex];
  return {
    url: String(input),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)) as SearchRequestBody,
  };
}

/** The search result mode each issued request asked for, in call order. */
function requestedModes(): Array<string | undefined> {
  return fetchMock.mock.calls.map(
    (_call, index) =>
      capturedRequest(index).body.contentSearchSpec?.searchResultMode,
  );
}

/** Narrows a tool result to its success variant, surfacing the API error. */
function expectSuccess(
  result: DiscoveryEngineSearchToolResult,
): DiscoveryEngineSearchResult[] {
  if (result.status !== 'success') {
    throw new Error(`expected success, got error: ${result.error_message}`);
  }
  return result.results;
}

/** Narrows a tool result to its error variant, surfacing unexpected results. */
function expectError(result: DiscoveryEngineSearchToolResult): string {
  if (result.status !== 'error') {
    throw new Error(
      `expected an error, got ${result.results.length} result(s)`,
    );
  }
  return result.error_message;
}

/** Runs a search and returns the host the request was sent to. */
async function resolvedHost(tool: DiscoveryEngineSearchTool): Promise<string> {
  await tool.discoveryEngineSearch('q');
  return new URL(capturedRequest().url).host;
}

describe('DiscoveryEngineSearchTool', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    respondWith({results: []});
    globalThis.fetch = fetchMock;
    mockQuotaProjectId = 'test-quota-project';
    mockAuthorization = 'Bearer fake-token';
  });

  describe('constructor / validation', () => {
    it('builds the serving config from dataStoreId', async () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      await tool.discoveryEngineSearch('q');
      expect(capturedRequest().url).toContain(
        '/test_data_store/servingConfigs/default_config:search',
      );
    });

    it('throws when no ids are specified', () => {
      expect(() => new DiscoveryEngineSearchTool({})).toThrow(
        'Either dataStoreId or searchEngineId must be specified.',
      );
    });

    it('throws when both ids are specified', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            searchEngineId: 'test_search_engine',
          }),
      ).toThrow('Either dataStoreId or searchEngineId must be specified.');
    });

    it('throws when dataStoreSpecs is set without searchEngineId', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            dataStoreSpecs: [{dataStore: '123'}],
          }),
      ).toThrow(
        'searchEngineId must be specified if dataStoreSpecs is specified.',
      );
    });

    it('exposes the expected declaration', () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      expect(tool.name).toBe('discovery_engine_search');
      expect(tool._getDeclaration()).toEqual({
        name: 'discovery_engine_search',
        description:
          "Search through Vertex AI Search's discovery engine search API.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {type: Type.STRING, description: 'The search query.'},
          },
          required: ['query'],
        },
      });
    });
  });

  describe('location / endpoint resolution', () => {
    it.each([
      [
        'projects/test/locations/eu/collections/default_collection/dataStores/test_data_store',
        'eu-discoveryengine.googleapis.com',
      ],
      [
        'projects/test/locations/europe-west1/collections/default_collection/dataStores/test_data_store',
        'europe-west1-discoveryengine.googleapis.com',
      ],
    ])(
      'resolves the regional endpoint for dataStoreId %s',
      async (dataStoreId, expectedHost) => {
        const tool = new DiscoveryEngineSearchTool({dataStoreId});
        expect(await resolvedHost(tool)).toBe(expectedHost);
      },
    );

    it('uses an explicit location override on a bare id', async () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        location: 'eu',
      });
      expect(await resolvedHost(tool)).toBe(
        'eu-discoveryengine.googleapis.com',
      );
    });

    it('accepts a location override that matches the resource location', async () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId:
          'projects/test/locations/eu/collections/default_collection/dataStores/test_data_store',
        location: 'EU',
      });
      expect(await resolvedHost(tool)).toBe(
        'eu-discoveryengine.googleapis.com',
      );
    });

    it('throws and makes no calls on a mismatched location override', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId:
              'projects/test/locations/us/collections/default_collection/dataStores/test_data_store',
            location: 'eu',
          }),
      ).toThrow(
        'location must match the location in dataStoreId or searchEngineId.',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws on an empty location override', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId:
              'projects/test/locations/us/collections/default_collection/dataStores/test_data_store',
            location: ' ',
          }),
      ).toThrow('location must not be empty if specified.');
    });

    it('throws on an override with invalid characters', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            location: 'attacker.com#',
          }),
      ).toThrow('location must contain only letters, digits, and hyphens.');
    });

    it('throws on an invalid location embedded in the resource id', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId:
              'projects/test/locations/attacker.com#/collections/default_collection/dataStores/test_data_store',
          }),
      ).toThrow('Invalid location in dataStoreId or searchEngineId.');
    });

    it('keeps the default endpoint for the global location', async () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId:
          'projects/test/locations/global/collections/default_collection/dataStores/test_data_store',
      });
      expect(await resolvedHost(tool)).toBe('discoveryengine.googleapis.com');
    });

    it('defaults a bare id to the global endpoint', async () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      expect(await resolvedHost(tool)).toBe('discoveryengine.googleapis.com');
    });
  });

  describe('mTLS endpoint resolution', () => {
    const originalEnv = process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];
      } else {
        process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = originalEnv;
      }
    });

    it('uses the global mTLS endpoint when GOOGLE_API_USE_MTLS_ENDPOINT=always', async () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'always';
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      expect(await resolvedHost(tool)).toBe(
        'discoveryengine.mtls.googleapis.com',
      );
    });

    it('uses the plain endpoint for other GOOGLE_API_USE_MTLS_ENDPOINT values', async () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'never';
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        location: 'eu',
      });
      expect(await resolvedHost(tool)).toBe(
        'eu-discoveryengine.googleapis.com',
      );
    });
  });

  describe('search behavior', () => {
    it('parses a CHUNKS result in auto mode (single request)', async () => {
      respondWith({
        results: [
          {
            chunk: {
              content: 'Test Content',
              documentMetadata: {
                title: 'Test Title',
                uri: 'gs://test_bucket/test_file',
                structData: {key1: 'value1', uri: 'http://example.com'},
              },
            },
          },
        ],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      const result = await tool.discoveryEngineSearch('test query');

      expect(result).toEqual({
        status: 'success',
        results: [
          {
            title: 'Test Title',
            url: 'http://example.com',
            content: 'Test Content',
          },
        ],
      });
      expect(requestedModes()).toEqual(['CHUNKS']);
    });

    it('falls back to the metadata uri when structData has none', async () => {
      respondWith({
        results: [
          {
            chunk: {
              content: 'c',
              documentMetadata: {
                title: 't',
                uri: 'gs://bucket/file',
                structData: {key1: 'value1'},
              },
            },
          },
        ],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('q');
      expect(result).toEqual({
        status: 'success',
        results: [{title: 't', url: 'gs://bucket/file', content: 'c'}],
      });
    });

    it('defaults a chunk with no metadata/content to empty fields', async () => {
      respondWith({results: [{chunk: {}}]});

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('q');
      expect(result).toEqual({
        status: 'success',
        results: [{title: '', url: '', content: ''}],
      });
    });

    it('skips chunk results whose chunk sub-object is missing', async () => {
      respondWith({results: [{document: {}}, {chunk: {content: 'kept'}}]});

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('q');
      expect(result).toEqual({
        status: 'success',
        results: [{title: '', url: '', content: 'kept'}],
      });
    });

    it('returns an error result on an API error', async () => {
      fetchMock.mockImplementation(async () =>
        errorResponse(500, 'Internal error'),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('test query');
      expect(expectError(result)).toContain('Internal error');
    });

    it('returns an error result when fetch rejects with a non-Error', async () => {
      fetchMock.mockRejectedValue('boom');

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('q');
      expect(result).toEqual({status: 'error', error_message: 'boom'});
    });

    it('returns an empty result set for CHUNKS with no results', async () => {
      respondWith({});

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('test query');
      expect(result).toEqual({status: 'success', results: []});
    });

    it('parses DOCUMENTS structured data', async () => {
      respondWith({
        results: [
          {
            document: {
              structData: {
                title: 'Jira Issue',
                uri: 'https://jira.example.com/123',
                summary: 'Bug fix for login',
              },
            },
          },
        ],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const results = expectSuccess(
        await tool.discoveryEngineSearch('test query'),
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Jira Issue');
      expect(results[0].url).toBe('https://jira.example.com/123');
      expect(results[0].content).toContain('Bug fix for login');
      expect(results[0].content).not.toContain('jira.example.com');
    });

    it('parses DOCUMENTS structured data with a link fallback', async () => {
      respondWith({
        results: [
          {document: {structData: {title: 'T', link: 'https://l', a: 1}}},
        ],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const results = expectSuccess(await tool.discoveryEngineSearch('q'));
      expect(results[0]).toEqual({
        title: 'T',
        url: 'https://l',
        content: '{"a":1}',
      });
    });

    it('defaults DOCUMENTS structured url to empty when no uri/link', async () => {
      respondWith({results: [{document: {structData: {summary: 's'}}}]});

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const results = expectSuccess(await tool.discoveryEngineSearch('q'));
      expect(results[0]).toEqual({
        title: '',
        url: '',
        content: '{"summary":"s"}',
      });
    });

    it('parses DOCUMENTS unstructured data', async () => {
      respondWith({
        results: [
          {
            document: {
              derivedStructData: {
                title: 'Web Page',
                link: 'https://example.com',
                snippets: [{snippet: 'Relevant text here'}],
              },
            },
          },
        ],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const results = expectSuccess(
        await tool.discoveryEngineSearch('test query'),
      );
      expect(results[0]).toEqual({
        title: 'Web Page',
        url: 'https://example.com',
        content: 'Relevant text here',
      });
    });

    it('renders snippet entries without a snippet field and non-object entries', async () => {
      respondWith({
        results: [
          {
            document: {
              derivedStructData: {
                snippets: [{other: 'x'}, 'raw snippet', {snippet: ''}],
              },
            },
          },
        ],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const results = expectSuccess(await tool.discoveryEngineSearch('q'));
      expect(results[0].content).toBe(
        '{"other":"x"}\nraw snippet\n{"snippet":""}',
      );
    });

    it('falls back to extractive_answers when there are no snippets', async () => {
      // The API returns the snake_case key with object entries carrying
      // `content` — see the Discovery Engine "extractive answers" reference.
      respondWith({
        results: [
          {
            document: {
              derivedStructData: {
                title: 'Doc',
                extractive_answers: [
                  {pageNumber: '2', content: 'answer one'},
                  {pageNumber: '5', content: 'answer two'},
                ],
              },
            },
          },
        ],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const results = expectSuccess(await tool.discoveryEngineSearch('q'));
      expect(results[0].content).toBe('answer one\nanswer two');
    });

    it('skips document results whose document sub-object is missing', async () => {
      respondWith({
        results: [{chunk: {content: 'ignored'}}, {document: {name: 'd'}}],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const results = expectSuccess(await tool.discoveryEngineSearch('q'));
      expect(results).toEqual([{title: '', url: '', content: ''}]);
    });

    it('coerces non-string struct data values to strings', async () => {
      respondWith({
        results: [
          {chunk: {content: 'c', documentMetadata: {structData: {uri: 42}}}},
        ],
      });

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const results = expectSuccess(await tool.discoveryEngineSearch('q'));
      expect(results[0].url).toBe('42');
    });
  });

  describe('auto-detection', () => {
    it('falls back to DOCUMENTS on the structured-store error and caches it', async () => {
      fetchMock
        .mockImplementationOnce(async () =>
          errorResponse(400, STRUCTURED_ERROR_TEXT),
        )
        .mockImplementation(async () =>
          okResponse({
            results: [
              {
                document: {
                  structData: {
                    title: 'Jira Issue',
                    uri: 'https://jira.example.com/123',
                    summary: 'Bug fix',
                  },
                },
              },
            ],
          }),
        );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      const results = expectSuccess(
        await tool.discoveryEngineSearch('test query'),
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Jira Issue');
      expect(requestedModes()).toEqual(['CHUNKS', 'DOCUMENTS']);

      // The resolved mode is cached: no second CHUNKS probe.
      expectSuccess(await tool.discoveryEngineSearch('another query'));
      expect(requestedModes()).toEqual(['CHUNKS', 'DOCUMENTS', 'DOCUMENTS']);
    });

    it('does not retry on an unrelated error', async () => {
      fetchMock.mockImplementation(async () =>
        errorResponse(403, 'Permission denied'),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      const result = await tool.discoveryEngineSearch('test query');
      expect(expectError(result)).toContain('Permission denied');
      expect(requestedModes()).toEqual(['CHUNKS']);
    });
  });

  describe('request construction and auth', () => {
    it('builds the correct URL, method, headers, and body', async () => {
      const tool = new DiscoveryEngineSearchTool({
        searchEngineId:
          'projects/test/locations/eu/collections/default_collection/engines/se',
        dataStoreSpecs: [{dataStore: 'ds1'}],
        filter: 'category=news',
        maxResults: 5,
        searchResultMode: SearchResultMode.CHUNKS,
      });
      await tool.discoveryEngineSearch('hello world');

      const request = capturedRequest();
      expect(request.url).toBe(
        'https://eu-discoveryengine.googleapis.com/v1beta/' +
          'projects/test/locations/eu/collections/default_collection/engines/se/' +
          'servingConfigs/default_config:search',
      );
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(request.headers.get('authorization')).toBe('Bearer fake-token');
      expect(request.headers.get('x-goog-user-project')).toBe(
        'test-quota-project',
      );

      expect(request.body).toEqual({
        query: 'hello world',
        contentSearchSpec: {
          searchResultMode: 'CHUNKS',
          chunkSpec: {numPreviousChunks: 0, numNextChunks: 0},
        },
        dataStoreSpecs: [{dataStore: 'ds1'}],
        filter: 'category=news',
        pageSize: 5,
      });
    });

    it('builds the DOCUMENTS content search spec', async () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      await tool.discoveryEngineSearch('q');

      expect(capturedRequest().body).toEqual({
        query: 'q',
        contentSearchSpec: {searchResultMode: 'DOCUMENTS'},
      });
      // An explicit mode skips the CHUNKS probe entirely.
      expect(requestedModes()).toEqual(['DOCUMENTS']);
    });

    it('omits optional headers/body fields when unset', async () => {
      mockQuotaProjectId = undefined;
      mockAuthorization = null;

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      await tool.discoveryEngineSearch('q');

      const request = capturedRequest();
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('x-goog-user-project')).toBeNull();
      expect(request.body).not.toHaveProperty('filter');
      expect(request.body).not.toHaveProperty('pageSize');
      expect(request.body).not.toHaveProperty('dataStoreSpecs');
    });
  });

  describe('runAsync', () => {
    it('delegates to discoveryEngineSearch using the query arg', async () => {
      respondWith({results: [{chunk: {content: 'c'}}]});

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.runAsync({
        args: {query: 'from run async'},
        toolContext: {} as Context,
      });
      expect(result).toEqual({
        status: 'success',
        results: [{title: '', url: '', content: 'c'}],
      });
      expect(capturedRequest().body.query).toBe('from run async');
    });
  });
});
