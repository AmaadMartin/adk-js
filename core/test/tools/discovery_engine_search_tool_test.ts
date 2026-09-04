/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/tools/test_discovery_engine_search_tool.py` at `main`.
 * Test names are kept verbatim so a reviewer can grep for the original.
 *
 * adk-python asserts on `ClientOptions(api_endpoint=...)` because it builds a
 * generated client. This port speaks REST, so the same expectations are
 * asserted against the host of the request the tool actually sent.
 */

import {DiscoveryEngineSearchTool, SearchResultMode} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {
  apiErrorResponse,
  capturedRequests,
  constructUnchecked,
  FetchInit,
  requestBodyOf,
  requestedModes,
  searchResponse,
  STRUCTURED_STORE_ERROR,
} from './discovery_engine_search_tool_fixtures.js';

// A stand-in for Application Default Credentials. `x-goog-user-project` is
// what `google-auth-library` sets from the credentials' quota project.
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: () =>
      Promise.resolve({
        getRequestHeaders: () =>
          Promise.resolve(
            new Headers({
              'authorization': 'Bearer fake-token',
              'x-goog-user-project': 'test-quota-project',
            }),
          ),
      }),
  })),
}));

describe('DiscoveryEngineSearchTool', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(searchResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Returns the host the tool addressed on its first request. */
  async function hostOf(tool: DiscoveryEngineSearchTool): Promise<string> {
    await tool.discoveryEngineSearch('test query');
    return new URL(capturedRequests(fetchMock)[0].url).host;
  }

  it('test_init_with_data_store_id', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
    });

    await tool.discoveryEngineSearch('test query');

    expect(capturedRequests(fetchMock)[0].url).toBe(
      'https://discoveryengine.googleapis.com/v1beta/' +
        'test_data_store/servingConfigs/default_config:search',
    );
  });

  it('test_init_with_search_engine_id', async () => {
    const tool = new DiscoveryEngineSearchTool({
      searchEngineId: 'test_search_engine',
    });

    await tool.discoveryEngineSearch('test query');

    expect(capturedRequests(fetchMock)[0].url).toBe(
      'https://discoveryengine.googleapis.com/v1beta/' +
        'test_search_engine/servingConfigs/default_config:search',
    );
  });

  it('test_init_with_no_ids_raises_error', () => {
    expect(() => constructUnchecked({})).toThrow(
      'Either dataStoreId or searchEngineId must be specified.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_init_with_both_ids_raises_error', () => {
    expect(() =>
      constructUnchecked({
        dataStoreId: 'test_data_store',
        searchEngineId: 'test_search_engine',
      }),
    ).toThrow('Either dataStoreId or searchEngineId must be specified.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_init_with_data_store_specs_without_search_engine_id_raises_error', () => {
    expect(() =>
      constructUnchecked({
        dataStoreId: 'test_data_store',
        dataStoreSpecs: [{dataStore: '123'}],
      }),
    ).toThrow(
      'searchEngineId must be specified if dataStoreSpecs is specified.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_init_with_regional_location_uses_regional_endpoint [eu]', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId:
        'projects/test/locations/eu/collections/default_collection/' +
        'dataStores/test_data_store',
    });

    expect(await hostOf(tool)).toBe('eu-discoveryengine.googleapis.com');
  });

  it('test_init_with_regional_location_uses_regional_endpoint [us]', async () => {
    const tool = new DiscoveryEngineSearchTool({
      searchEngineId:
        'projects/test/locations/us/collections/default_collection/' +
        'engines/test_search_engine',
    });

    expect(await hostOf(tool)).toBe('us-discoveryengine.googleapis.com');
  });

  it('test_init_with_regional_location_uses_regional_endpoint [europe-west1]', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId:
        'projects/test/locations/europe-west1/collections/' +
        'default_collection/dataStores/test_data_store',
    });

    expect(await hostOf(tool)).toBe(
      'europe-west1-discoveryengine.googleapis.com',
    );
  });

  it('test_init_with_explicit_location_override_uses_input_location', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
      location: 'eu',
    });

    expect(await hostOf(tool)).toBe('eu-discoveryengine.googleapis.com');
  });

  it('test_init_with_mismatched_location_raises_error', () => {
    expect(
      () =>
        new DiscoveryEngineSearchTool({
          dataStoreId:
            'projects/test/locations/us/collections/default_collection/' +
            'dataStores/test_data_store',
          location: 'eu',
        }),
    ).toThrow(
      'location must match the location in dataStoreId or searchEngineId.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_init_with_empty_location_raises_error', () => {
    expect(
      () =>
        new DiscoveryEngineSearchTool({
          dataStoreId:
            'projects/test/locations/us/collections/default_collection/' +
            'dataStores/test_data_store',
          location: ' ',
        }),
    ).toThrow('location must not be empty if specified.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_init_with_invalid_override_location_raises_error', () => {
    expect(
      () =>
        new DiscoveryEngineSearchTool({
          dataStoreId: 'test_data_store',
          location: 'attacker.com#',
        }),
    ).toThrow('location must contain only letters, digits, and hyphens.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_init_with_invalid_resource_location_raises_error', () => {
    expect(
      () =>
        new DiscoveryEngineSearchTool({
          dataStoreId:
            'projects/test/locations/attacker.com#/collections/' +
            'default_collection/dataStores/test_data_store',
        }),
    ).toThrow('Invalid location in dataStoreId or searchEngineId.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_init_with_global_location_keeps_default_endpoint', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId:
        'projects/test/locations/global/collections/default_collection/' +
        'dataStores/test_data_store',
    });

    expect(await hostOf(tool)).toBe('discoveryengine.googleapis.com');
  });

  it('test_init_with_regional_location_and_quota_project_id', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId:
        'projects/test/locations/eu/collections/default_collection/' +
        'dataStores/test_data_store',
    });

    expect(await hostOf(tool)).toBe('eu-discoveryengine.googleapis.com');
    expect(
      capturedRequests(fetchMock)[0].headers.get('x-goog-user-project'),
    ).toBe('test-quota-project');
  });

  it('test_discovery_engine_search_success', async () => {
    fetchMock.mockResolvedValue(
      searchResponse({
        chunk: {
          documentMetadata: {
            title: 'Test Title',
            uri: 'gs://test_bucket/test_file',
            structData: {key1: 'value1', uri: 'http://example.com'},
          },
          content: 'Test Content',
        },
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
    expect(capturedRequests(fetchMock)[0].headers.get('authorization')).toBe(
      'Bearer fake-token',
    );
  });

  it('test_discovery_engine_search_api_error', async () => {
    // adk-python expects 'None API error': `str(GoogleAPICallError)` prefixes
    // the message with the absent code. The API's own message is asserted here.
    fetchMock.mockResolvedValue(apiErrorResponse(500, 'API error'));
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
    });

    const result = await tool.discoveryEngineSearch('test query');

    expect(result).toEqual({status: 'error', error_message: 'API error'});
  });

  it('test_discovery_engine_search_no_results', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
    });

    const result = await tool.discoveryEngineSearch('test query');

    expect(result).toEqual({status: 'success', results: []});
  });

  it('test_init_default_search_result_mode', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
    });

    await tool.discoveryEngineSearch('test query');

    expect(requestedModes(fetchMock)).toEqual(['CHUNKS']);
  });

  it('test_init_with_documents_mode', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
      searchResultMode: SearchResultMode.DOCUMENTS,
    });

    await tool.discoveryEngineSearch('test query');

    expect(requestedModes(fetchMock)).toEqual(['DOCUMENTS']);
    expect(
      capturedRequests(fetchMock)[0].body.contentSearchSpec.chunkSpec,
    ).toBeUndefined();
  });

  it('test_discovery_engine_search_documents_structured', async () => {
    fetchMock.mockResolvedValue(
      searchResponse({
        document: {
          name: 'projects/p/locations/l/doc1',
          id: 'doc1',
          structData: {
            title: 'Jira Issue',
            uri: 'https://jira.example.com/123',
            summary: 'Bug fix for login',
          },
        },
      }),
    );
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
      searchResultMode: SearchResultMode.DOCUMENTS,
    });

    const result = await tool.discoveryEngineSearch('test query');

    expect(result).toEqual({
      status: 'success',
      results: [
        {
          title: 'Jira Issue',
          url: 'https://jira.example.com/123',
          content: '{"summary":"Bug fix for login"}',
        },
      ],
    });
  });

  it('test_discovery_engine_search_documents_unstructured', async () => {
    fetchMock.mockResolvedValue(
      searchResponse({
        document: {
          name: 'projects/p/locations/l/doc2',
          id: 'doc2',
          derivedStructData: {
            title: 'Web Page',
            link: 'https://example.com',
            snippets: [{snippet: 'Relevant text here'}],
          },
        },
      }),
    );
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
      searchResultMode: SearchResultMode.DOCUMENTS,
    });

    const result = await tool.discoveryEngineSearch('test query');

    expect(result).toEqual({
      status: 'success',
      results: [
        {
          title: 'Web Page',
          url: 'https://example.com',
          content: 'Relevant text here',
        },
      ],
    });
  });

  it('test_discovery_engine_search_documents_no_results', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
      searchResultMode: SearchResultMode.DOCUMENTS,
    });

    const result = await tool.discoveryEngineSearch('test query');

    expect(result).toEqual({status: 'success', results: []});
  });

  it('test_auto_detect_falls_back_to_documents', async () => {
    fetchMock
      .mockResolvedValueOnce(apiErrorResponse(400, STRUCTURED_STORE_ERROR))
      .mockResolvedValue(
        searchResponse({
          document: {
            structData: {
              title: 'Jira Issue',
              uri: 'https://jira.example.com/123',
              summary: 'Bug fix',
            },
          },
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
          title: 'Jira Issue',
          url: 'https://jira.example.com/123',
          content: '{"summary":"Bug fix"}',
        },
      ],
    });
    expect(requestedModes(fetchMock)).toEqual(['CHUNKS', 'DOCUMENTS']);

    // The mode is persisted, so a later call skips the retry.
    await tool.discoveryEngineSearch('second query');
    expect(requestedModes(fetchMock)).toEqual([
      'CHUNKS',
      'DOCUMENTS',
      'DOCUMENTS',
    ]);
  });

  it('test_auto_detect_caches_chunks_on_success', async () => {
    fetchMock.mockResolvedValue(
      searchResponse({
        chunk: {
          documentMetadata: {
            title: 'Jira Issue',
            uri: 'https://jira.example.com/123',
            structData: {summary: 'Bug fix'},
          },
          content: 'Bug fix',
        },
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
          title: 'Jira Issue',
          url: 'https://jira.example.com/123',
          content: 'Bug fix',
        },
      ],
    });
    expect(requestedModes(fetchMock)).toEqual(['CHUNKS']);

    // The mode is persisted as CHUNKS, so a later call does not probe again.
    await tool.discoveryEngineSearch('second query');
    expect(requestedModes(fetchMock)).toEqual(['CHUNKS', 'CHUNKS']);
  });

  it('test_auto_detect_singleflights_structured_fallback', async () => {
    const workerCount = 8;
    fetchMock.mockImplementation((_url: string, init: FetchInit) => {
      if (requestBodyOf(init).contentSearchSpec.searchResultMode === 'CHUNKS') {
        return Promise.resolve(apiErrorResponse(400, STRUCTURED_STORE_ERROR));
      }
      return Promise.resolve(
        searchResponse({
          document: {
            structData: {
              title: 'Jira Issue',
              uri: 'https://jira.example.com/123',
              summary: 'Bug fix',
            },
          },
        }),
      );
    });
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
    });

    const results = await Promise.all(
      Array.from({length: workerCount}, (_unused, index) =>
        tool.discoveryEngineSearch(`test query ${index}`),
      ),
    );

    expect(results.every((result) => result.status === 'success')).toBe(true);
    const modes = requestedModes(fetchMock);
    expect(modes.filter((mode) => mode === 'CHUNKS')).toHaveLength(1);
    expect(modes.filter((mode) => mode === 'DOCUMENTS')).toHaveLength(
      workerCount,
    );
  });

  it('test_auto_detect_does_not_retry_on_unrelated_error', async () => {
    fetchMock.mockResolvedValue(apiErrorResponse(403, 'Permission denied'));
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId: 'test_data_store',
    });

    const result = await tool.discoveryEngineSearch('test query');

    expect(result).toEqual({
      status: 'error',
      error_message: 'Permission denied',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
