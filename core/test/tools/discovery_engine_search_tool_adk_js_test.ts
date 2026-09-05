/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of `DiscoveryEngineSearchTool` that the ported adk-python tests in
 * `discovery_engine_search_tool_test.ts` do not reach: the request body the
 * options produce, the parsing edge cases, and the failure paths.
 */

import {
  Context,
  createSession,
  DiscoveryEngineSearchTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SearchResultMode,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {
  apiErrorResponse,
  capturedRequests,
  constructUnchecked,
  requestedModes,
  searchResponse,
  STRUCTURED_STORE_ERROR,
  textResponse,
} from './discovery_engine_search_tool_fixtures.js';

// A stand-in for Application Default Credentials, so no test resolves any.
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: () =>
      Promise.resolve({
        getRequestHeaders: () =>
          Promise.resolve(new Headers({authorization: 'Bearer fake-token'})),
      }),
  })),
}));

/** Builds a tool context, for driving the tool the way the model does. */
function makeToolContext(): Context {
  const agent = new LlmAgent({name: 'searcher', model: 'gemini-2.0-flash'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({
        id: 'session',
        appName: 'searcher',
        userId: 'user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
  });
}

describe('DiscoveryEngineSearchTool request body', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(searchResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for no surrounding chunks in CHUNKS mode', async () => {
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    await tool.discoveryEngineSearch('query');

    expect(capturedRequests(fetchMock)[0].body.contentSearchSpec).toEqual({
      searchResultMode: 'CHUNKS',
      chunkSpec: {numPreviousChunks: 0, numNextChunks: 0},
    });
  });

  it('sends filter, pageSize and dataStoreSpecs when they are set', async () => {
    const tool = new DiscoveryEngineSearchTool({
      searchEngineId: 'engine',
      dataStoreSpecs: [{dataStore: 'store-a'}],
      filter: 'category: ANY("news")',
      maxResults: 5,
    });

    await tool.discoveryEngineSearch('query');

    expect(capturedRequests(fetchMock)[0].body).toMatchObject({
      query: 'query',
      filter: 'category: ANY("news")',
      pageSize: 5,
      dataStoreSpecs: [{dataStore: 'store-a'}],
    });
  });

  it('omits filter, pageSize and dataStoreSpecs when they are unset', async () => {
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    await tool.discoveryEngineSearch('query');

    const body = capturedRequests(fetchMock)[0].body;
    expect(body.filter).toBeUndefined();
    expect(body.pageSize).toBeUndefined();
    expect(body.dataStoreSpecs).toBeUndefined();
  });

  it('omits pageSize when maxResults is zero', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'store',
      maxResults: 0,
    });

    await tool.discoveryEngineSearch('query');

    expect(capturedRequests(fetchMock)[0].body.pageSize).toBeUndefined();
  });

  it('accepts dataStoreSpecs alongside a searchEngineId', () => {
    expect(() =>
      constructUnchecked({
        searchEngineId: 'engine',
        dataStoreSpecs: [{dataStore: 'store-a'}],
      }),
    ).not.toThrow();
  });

  it('rejects a model call that supplies no query', async () => {
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    await expect(
      tool.runAsync({args: {}, toolContext: makeToolContext()}),
    ).rejects.toThrow("Error in tool 'discovery_engine_search'");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('searches with the query a model call supplies', async () => {
    fetchMock.mockResolvedValue(
      searchResponse({
        chunk: {content: 'text', documentMetadata: {title: 'Title'}},
      }),
    );
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    const result = await tool.runAsync({
      args: {query: 'from the model'},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual({
      status: 'success',
      results: [{title: 'Title', url: '', content: 'text'}],
    });
    expect(capturedRequests(fetchMock)[0].body.query).toBe('from the model');
  });
});

describe('DiscoveryEngineSearchTool result parsing', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(searchResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Searches a store fixed to `mode` and returns the parsed results. */
  async function search(
    mode: SearchResultMode,
    ...results: Array<{chunk?: unknown; document?: unknown}>
  ) {
    fetchMock.mockResolvedValue(searchResponse(...results));
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'store',
      searchResultMode: mode,
    });
    return tool.discoveryEngineSearch('query');
  }

  it('prefers the struct data uri over the document metadata uri', async () => {
    const result = await search(SearchResultMode.CHUNKS, {
      chunk: {
        content: 'text',
        documentMetadata: {
          title: 'Title',
          uri: 'gs://bucket/file',
          structData: {uri: 'https://example.com/doc'},
        },
      },
    });

    expect(result).toEqual({
      status: 'success',
      results: [
        {title: 'Title', url: 'https://example.com/doc', content: 'text'},
      ],
    });
  });

  it('falls back to the document metadata uri and to empty fields', async () => {
    const result = await search(
      SearchResultMode.CHUNKS,
      {chunk: {content: 'a', documentMetadata: {uri: 'gs://bucket/file'}}},
      {chunk: {content: 'b'}},
    );

    expect(result).toEqual({
      status: 'success',
      results: [
        {title: '', url: 'gs://bucket/file', content: 'a'},
        {title: '', url: '', content: 'b'},
      ],
    });
  });

  it('drops link from the content whether or not uri supplied the url', async () => {
    const result = await search(
      SearchResultMode.DOCUMENTS,
      {
        document: {
          structData: {
            title: 'With uri',
            uri: 'https://example.com/a',
            link: 'https://example.com/ignored',
            summary: 'kept',
          },
        },
      },
      {
        document: {
          structData: {
            title: 'Without uri',
            link: 'https://example.com/b',
            summary: 'kept',
          },
        },
      },
    );

    expect(result).toEqual({
      status: 'success',
      results: [
        {
          title: 'With uri',
          url: 'https://example.com/a',
          content: '{"summary":"kept"}',
        },
        {
          title: 'Without uri',
          url: 'https://example.com/b',
          content: '{"summary":"kept"}',
        },
      ],
    });
  });

  it('serializes a non-string structured field into the content', async () => {
    const result = await search(SearchResultMode.DOCUMENTS, {
      document: {structData: {title: 42, priority: 3, tags: ['a', 'b']}},
    });

    expect(result).toEqual({
      status: 'success',
      results: [
        {title: '42', url: '', content: '{"priority":3,"tags":["a","b"]}'},
      ],
    });
  });

  it('stringifies a snippet that is not an object carrying a snippet', async () => {
    const result = await search(SearchResultMode.DOCUMENTS, {
      document: {
        derivedStructData: {
          title: 'Page',
          link: 'https://example.com',
          snippets: [
            {snippet: 'first'},
            'plain string',
            {snippet_status: 'NO_SNIPPET_AVAILABLE'},
          ],
        },
      },
    });

    expect(result).toEqual({
      status: 'success',
      results: [
        {
          title: 'Page',
          url: 'https://example.com',
          content:
            'first\nplain string\n{"snippet_status":"NO_SNIPPET_AVAILABLE"}',
        },
      ],
    });
  });

  it('falls back to the extractive answers when there are no snippets', async () => {
    const result = await search(
      SearchResultMode.DOCUMENTS,
      {
        document: {
          derivedStructData: {
            title: 'Empty snippets',
            link: 'https://example.com/a',
            snippets: [],
            extractive_answers: [{pageNumber: '1', content: 'answer'}],
          },
        },
      },
      {
        document: {
          derivedStructData: {
            title: 'No snippets field',
            link: 'https://example.com/b',
            extractive_answers: ['plain answer'],
          },
        },
      },
    );

    expect(result).toEqual({
      status: 'success',
      results: [
        {
          title: 'Empty snippets',
          url: 'https://example.com/a',
          content: '{"pageNumber":"1","content":"answer"}',
        },
        {
          title: 'No snippets field',
          url: 'https://example.com/b',
          content: 'plain answer',
        },
      ],
    });
  });

  it('reports no results when the response carries no results field', async () => {
    fetchMock.mockResolvedValue(textResponse(200, '{}'));
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'store',
      searchResultMode: SearchResultMode.CHUNKS,
    });

    expect(await tool.discoveryEngineSearch('query')).toEqual({
      status: 'success',
      results: [],
    });
  });

  it('reports empty fields for a document carrying neither struct', async () => {
    const result = await search(SearchResultMode.DOCUMENTS, {
      document: {name: 'projects/p/locations/l/doc1', id: 'doc1'},
    });

    expect(result).toEqual({
      status: 'success',
      results: [{title: '', url: '', content: ''}],
    });
  });

  it('skips a result that carries nothing for the requested mode', async () => {
    const result = await search(
      SearchResultMode.DOCUMENTS,
      {},
      {document: {}},
      {chunk: {content: 'wrong mode'}},
    );

    expect(result).toEqual({status: 'success', results: []});
  });

  it('skips a chunk result that is empty', async () => {
    const result = await search(SearchResultMode.CHUNKS, {}, {chunk: {}});

    expect(result).toEqual({status: 'success', results: []});
  });
});

describe('DiscoveryEngineSearchTool failure paths', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(searchResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the raw body when the failure is not a Google error envelope', async () => {
    fetchMock.mockResolvedValue(textResponse(502, '<html>Bad Gateway</html>'));
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    expect(await tool.discoveryEngineSearch('query')).toEqual({
      status: 'error',
      error_message: '<html>Bad Gateway</html>',
    });
  });

  it('reports the status when the failure carries no body', async () => {
    fetchMock.mockResolvedValue(textResponse(503, ''));
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    expect(await tool.discoveryEngineSearch('query')).toEqual({
      status: 'error',
      error_message: 'Discovery Engine search failed with HTTP 503.',
    });
  });

  it('reports a transport failure as an error result', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    expect(await tool.discoveryEngineSearch('query')).toEqual({
      status: 'error',
      error_message: 'socket hang up',
    });
  });

  it('probes again after a failed probe learned nothing about the store', async () => {
    fetchMock.mockResolvedValueOnce(apiErrorResponse(503, 'Unavailable'));
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    expect(await tool.discoveryEngineSearch('first')).toEqual({
      status: 'error',
      error_message: 'Unavailable',
    });

    expect(await tool.discoveryEngineSearch('second')).toEqual({
      status: 'success',
      results: [],
    });
    expect(requestedModes(fetchMock)).toEqual(['CHUNKS', 'CHUNKS']);
  });

  it('shares one probe between concurrent cold callers on a chunk store', async () => {
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    await Promise.all([
      tool.discoveryEngineSearch('a'),
      tool.discoveryEngineSearch('b'),
      tool.discoveryEngineSearch('c'),
    ]);

    // The probe answers its own caller, so three callers make three requests.
    expect(requestedModes(fetchMock)).toEqual(['CHUNKS', 'CHUNKS', 'CHUNKS']);
  });

  it('keeps DOCUMENTS mode after a fallback, for every later caller', async () => {
    fetchMock
      .mockResolvedValueOnce(apiErrorResponse(400, STRUCTURED_STORE_ERROR))
      .mockResolvedValue(searchResponse());
    const tool = new DiscoveryEngineSearchTool({dataStoreId: 'store'});

    await tool.discoveryEngineSearch('first');
    await Promise.all([
      tool.discoveryEngineSearch('second'),
      tool.discoveryEngineSearch('third'),
    ]);

    expect(requestedModes(fetchMock)).toEqual([
      'CHUNKS',
      'DOCUMENTS',
      'DOCUMENTS',
      'DOCUMENTS',
    ]);
  });
});
