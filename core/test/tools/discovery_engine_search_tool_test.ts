/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {DiscoveryEngineSearchTool, SearchResultMode} from '@google/adk';
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

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  };
}

const STRUCTURED_ERROR_TEXT =
  '`content_search_spec.search_result_mode` must be set to ' +
  'SearchRequest.ContentSearchSpec.SearchResultMode.DOCUMENTS when the ' +
  'engine contains structured data store.';

/** Reads a private field for assertions (mirrors the Python `tool._x` checks). */
function priv<T = unknown>(tool: DiscoveryEngineSearchTool, key: string): T {
  return (tool as any)[key] as T;
}

describe('DiscoveryEngineSearchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    mockQuotaProjectId = 'test-quota-project';
    mockAuthorization = 'Bearer fake-token';
  });

  describe('constructor / validation', () => {
    it('builds the serving config from dataStoreId', () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      expect(priv(tool, 'servingConfig')).toBe(
        'test_data_store/servingConfigs/default_config',
      );
    });

    it('builds the serving config from searchEngineId', () => {
      const tool = new DiscoveryEngineSearchTool({
        searchEngineId: 'test_search_engine',
      });
      expect(priv(tool, 'servingConfig')).toBe(
        'test_search_engine/servingConfigs/default_config',
      );
    });

    it('throws when no ids are specified', () => {
      expect(() => new DiscoveryEngineSearchTool({})).toThrow(
        'Either data_store_id or search_engine_id must be specified.',
      );
    });

    it('throws when both ids are specified', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            searchEngineId: 'test_search_engine',
          }),
      ).toThrow('Either data_store_id or search_engine_id must be specified.');
    });

    it('throws when dataStoreSpecs is set without searchEngineId', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            dataStoreSpecs: [{dataStore: '123'}],
          }),
      ).toThrow(
        'search_engine_id must be specified if data_store_specs is specified.',
      );
    });

    it('accepts dataStoreSpecs together with searchEngineId', () => {
      const tool = new DiscoveryEngineSearchTool({
        searchEngineId: 'test_search_engine',
        dataStoreSpecs: [{dataStore: 'ds1'}],
      });
      expect(priv(tool, 'dataStoreSpecs')).toEqual([{dataStore: 'ds1'}]);
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
        'dataStoreId',
      ],
      [
        'projects/test/locations/us/collections/default_collection/engines/test_search_engine',
        'us-discoveryengine.googleapis.com',
        'searchEngineId',
      ],
      [
        'projects/test/locations/europe-west1/collections/default_collection/dataStores/test_data_store',
        'europe-west1-discoveryengine.googleapis.com',
        'dataStoreId',
      ],
    ])(
      'resolves the regional endpoint for %s',
      (resourceId, expectedEndpoint, key) => {
        const tool = new DiscoveryEngineSearchTool({[key]: resourceId});
        expect(priv(tool, 'endpoint')).toBe(expectedEndpoint);
      },
    );

    it('uses an explicit location override on a bare id', () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        location: 'eu',
      });
      expect(priv(tool, 'endpoint')).toBe('eu-discoveryengine.googleapis.com');
    });

    it('accepts a location override that matches the resource location', () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId:
          'projects/test/locations/eu/collections/default_collection/dataStores/test_data_store',
        location: 'EU',
      });
      expect(priv(tool, 'endpoint')).toBe('eu-discoveryengine.googleapis.com');
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
        'location must match the location in data_store_id or search_engine_id.',
      );
      expect(global.fetch).not.toHaveBeenCalled();
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
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws on an override with invalid characters', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId: 'test_data_store',
            location: 'attacker.com#',
          }),
      ).toThrow('location must contain only letters, digits, and hyphens.');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws on an invalid location embedded in the resource id', () => {
      expect(
        () =>
          new DiscoveryEngineSearchTool({
            dataStoreId:
              'projects/test/locations/attacker.com#/collections/default_collection/dataStores/test_data_store',
          }),
      ).toThrow('Invalid location in data_store_id or search_engine_id.');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('keeps the default endpoint for the global location', () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId:
          'projects/test/locations/global/collections/default_collection/dataStores/test_data_store',
      });
      expect(priv(tool, 'endpoint')).toBe('discoveryengine.googleapis.com');
    });

    it('defaults a bare id to the global endpoint', () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      expect(priv(tool, 'endpoint')).toBe('discoveryengine.googleapis.com');
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

    it('uses the mTLS endpoint when GOOGLE_API_USE_MTLS_ENDPOINT=always', () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'always';
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        location: 'eu',
      });
      expect(priv(tool, 'endpoint')).toBe(
        'eu-discoveryengine.mtls.googleapis.com',
      );
    });

    it('uses the plain endpoint for other GOOGLE_API_USE_MTLS_ENDPOINT values', () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'never';
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        location: 'eu',
      });
      expect(priv(tool, 'endpoint')).toBe('eu-discoveryengine.googleapis.com');
    });
  });

  describe('search behavior', () => {
    it('parses a CHUNKS result in auto mode (single request)', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
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
        }),
      );

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
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(priv(tool, 'searchResultMode')).toBe(SearchResultMode.CHUNKS);
    });

    it('falls back to the metadata uri when structData has none', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
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
        }),
      );

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
      (global.fetch as any).mockResolvedValue(
        okResponse({results: [{chunk: {}}]}),
      );

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
      (global.fetch as any).mockResolvedValue(
        okResponse({
          results: [{document: {}}, {chunk: {content: 'kept'}}],
        }),
      );

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
      (global.fetch as any).mockResolvedValue(
        errorResponse(500, 'Internal error'),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('test query');
      expect(result.status).toBe('error');
      expect((result as {error_message: string}).error_message).toContain(
        'Internal error',
      );
    });

    it('returns an error result when fetch rejects with a non-Error', async () => {
      (global.fetch as any).mockRejectedValue('boom');

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('q');
      expect(result).toEqual({status: 'error', error_message: 'boom'});
    });

    it('returns an empty result set for CHUNKS with no results', async () => {
      (global.fetch as any).mockResolvedValue(okResponse({}));

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('test query');
      expect(result).toEqual({status: 'success', results: []});
    });

    it('defaults searchResultMode to undefined (auto)', () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      expect(priv(tool, 'searchResultMode')).toBeUndefined();
    });

    it('stores an explicit DOCUMENTS mode', () => {
      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      expect(priv(tool, 'searchResultMode')).toBe(SearchResultMode.DOCUMENTS);
    });

    it('parses DOCUMENTS structured data', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
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
        }),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('test query');
      expect(result.status).toBe('success');
      const results = (result as {results: any[]}).results;
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Jira Issue');
      expect(results[0].url).toBe('https://jira.example.com/123');
      expect(results[0].content).toContain('Bug fix for login');
      expect(results[0].content).not.toContain('jira.example.com');
    });

    it('parses DOCUMENTS structured data with a link fallback', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
          results: [
            {document: {structData: {title: 'T', link: 'https://l', a: 1}}},
          ],
        }),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('q');
      const results = (result as {results: any[]}).results;
      expect(results[0]).toEqual({
        title: 'T',
        url: 'https://l',
        content: '{"a":1}',
      });
    });

    it('defaults DOCUMENTS structured url to empty when no uri/link', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({results: [{document: {structData: {summary: 's'}}}]}),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('q');
      const results = (result as {results: any[]}).results;
      expect(results[0]).toEqual({
        title: '',
        url: '',
        content: '{"summary":"s"}',
      });
    });

    it('parses DOCUMENTS unstructured data', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
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
        }),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('test query');
      const results = (result as {results: any[]}).results;
      expect(results[0]).toEqual({
        title: 'Web Page',
        url: 'https://example.com',
        content: 'Relevant text here',
      });
    });

    it('renders snippet entries without a snippet field and non-object entries', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
          results: [
            {
              document: {
                derivedStructData: {
                  snippets: [{other: 'x'}, 'raw snippet', {snippet: ''}],
                },
              },
            },
          ],
        }),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('q');
      const results = (result as {results: any[]}).results;
      expect(results[0].content).toBe(
        '{"other":"x"}\nraw snippet\n{"snippet":""}',
      );
    });

    it('falls back to extractiveAnswers when there are no snippets', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
          results: [
            {
              document: {
                derivedStructData: {
                  title: 'Doc',
                  extractiveAnswers: ['answer one', 'answer two'],
                },
              },
            },
          ],
        }),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('q');
      const results = (result as {results: any[]}).results;
      expect(results[0].content).toBe('answer one\nanswer two');
    });

    it('returns empty fields for a document with no struct data', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({results: [{document: {name: 'doc'}}]}),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('q');
      const results = (result as {results: any[]}).results;
      expect(results[0]).toEqual({title: '', url: '', content: ''});
    });

    it('skips document results whose document sub-object is missing', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
          results: [{chunk: {content: 'ignored'}}, {document: {name: 'd'}}],
        }),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('q');
      const results = (result as {results: any[]}).results;
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('');
    });

    it('returns an empty result set for DOCUMENTS with no results', async () => {
      (global.fetch as any).mockResolvedValue(okResponse({}));

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      const result = await tool.discoveryEngineSearch('test query');
      expect(result).toEqual({status: 'success', results: []});
    });

    it('coerces non-string struct data values to strings', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({
          results: [
            {
              chunk: {
                content: 'c',
                documentMetadata: {structData: {uri: 42}},
              },
            },
          ],
        }),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.discoveryEngineSearch('q');
      const results = (result as {results: any[]}).results;
      expect(results[0].url).toBe('42');
    });
  });

  describe('auto-detection', () => {
    it('falls back to DOCUMENTS on the structured-store error (2 requests)', async () => {
      (global.fetch as any)
        .mockResolvedValueOnce(errorResponse(400, STRUCTURED_ERROR_TEXT))
        .mockResolvedValueOnce(
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
      const result = await tool.discoveryEngineSearch('test query');
      const results = (result as {results: any[]}).results;
      expect(result.status).toBe('success');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Jira Issue');
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(priv(tool, 'searchResultMode')).toBe(SearchResultMode.DOCUMENTS);
    });

    it('caches CHUNKS on a successful probe (1 request)', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({results: [{chunk: {content: 'c'}}]}),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      await tool.discoveryEngineSearch('test query');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(priv(tool, 'searchResultMode')).toBe(SearchResultMode.CHUNKS);

      // A second call reuses the cached mode without re-probing.
      await tool.discoveryEngineSearch('another query');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry on an unrelated error (1 request)', async () => {
      (global.fetch as any).mockResolvedValue(
        errorResponse(403, 'Permission denied'),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
      });
      const result = await tool.discoveryEngineSearch('test query');
      expect(result.status).toBe('error');
      expect((result as {error_message: string}).error_message).toContain(
        'Permission denied',
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(priv(tool, 'searchResultMode')).toBeUndefined();
    });
  });

  describe('request construction and auth', () => {
    it('builds the correct URL, method, headers, and body', async () => {
      (global.fetch as any).mockResolvedValue(okResponse({results: []}));

      const tool = new DiscoveryEngineSearchTool({
        searchEngineId:
          'projects/test/locations/eu/collections/default_collection/engines/se',
        dataStoreSpecs: [{dataStore: 'ds1'}],
        filter: 'category=news',
        maxResults: 5,
        searchResultMode: SearchResultMode.CHUNKS,
      });
      await tool.discoveryEngineSearch('hello world');

      const [url, init] = (global.fetch as any).mock.calls[0];
      expect(url).toBe(
        'https://eu-discoveryengine.googleapis.com/v1beta/' +
          'projects/test/locations/eu/collections/default_collection/engines/se/' +
          'servingConfigs/default_config:search',
      );
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.headers['Authorization']).toBe('Bearer fake-token');
      expect(init.headers['x-goog-user-project']).toBe('test-quota-project');

      expect(JSON.parse(init.body)).toEqual({
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
      (global.fetch as any).mockResolvedValue(okResponse({results: []}));

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.DOCUMENTS,
      });
      await tool.discoveryEngineSearch('q');

      const [, init] = (global.fetch as any).mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({
        query: 'q',
        contentSearchSpec: {searchResultMode: 'DOCUMENTS'},
      });
    });

    it('omits optional headers/body fields when unset', async () => {
      mockQuotaProjectId = undefined;
      mockAuthorization = null;
      (global.fetch as any).mockResolvedValue(okResponse({results: []}));

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      await tool.discoveryEngineSearch('q');

      const [, init] = (global.fetch as any).mock.calls[0];
      expect(init.headers['Authorization']).toBeUndefined();
      expect(init.headers['x-goog-user-project']).toBeUndefined();
      const parsed = JSON.parse(init.body);
      expect(parsed).not.toHaveProperty('filter');
      expect(parsed).not.toHaveProperty('pageSize');
      expect(parsed).not.toHaveProperty('dataStoreSpecs');
    });
  });

  describe('runAsync', () => {
    it('delegates to discoveryEngineSearch using the query arg', async () => {
      (global.fetch as any).mockResolvedValue(
        okResponse({results: [{chunk: {content: 'c'}}]}),
      );

      const tool = new DiscoveryEngineSearchTool({
        dataStoreId: 'test_data_store',
        searchResultMode: SearchResultMode.CHUNKS,
      });
      const result = await tool.runAsync({
        args: {query: 'from run async'},
        toolContext: {} as any,
      });
      expect(result).toEqual({
        status: 'success',
        results: [{title: '', url: '', content: 'c'}],
      });
      const [, init] = (global.fetch as any).mock.calls[0];
      expect(JSON.parse(init.body).query).toBe('from run async');
    });
  });
});
