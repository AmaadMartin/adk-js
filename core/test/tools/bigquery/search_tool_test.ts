/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_search_tool.py`
 * (branch `main`).
 */

import {
  BigQueryClientCache,
  createBigQueryToolConfig,
  DP_USER_AGENT,
  searchCatalog,
  type BigQueryToolConfig,
  type BigQueryToolDeps,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  constructSearchQuery,
  constructSearchQueryClause,
} from '../../../src/tools/bigquery/search_tool.js';
import {bigQueryState, resetBigQueryState} from './bigquery_fakes.js';

vi.mock('@google-cloud/dataplex', async () => {
  const {FakeCatalogServiceClient} = await import('./bigquery_fakes.js');
  return {CatalogServiceClient: FakeCatalogServiceClient};
});

/** Builds the deps the search tool runs with. */
function deps(config: BigQueryToolConfig = {}): BigQueryToolDeps {
  return {
    clients: new BigQueryClientCache(),
    settings: createBigQueryToolConfig(config),
  };
}

/** The request the fake Dataplex client recorded, as a record. */
function lastSearchRequest(): Record<string, unknown> {
  const request = bigQueryState.searchRequests.at(-1);
  if (typeof request !== 'object' || request === null) {
    return expect.fail('the fake recorded no search request');
  }
  return request as Record<string, unknown>;
}

beforeEach(() => {
  resetBigQueryState();
});

describe('searchCatalog', () => {
  it('test_search_catalog_success', async () => {
    bigQueryState.searchResults = [
      {
        dataplexEntry: {
          name: 'projects/p/locations/us/entryGroups/@bigquery/entries/e',
          entryType: 'projects/p/locations/l/entryTypes/bigquery-table',
          updateTime: '2024-01-01 12:00:00+00:00',
          entrySource: {
            displayName: 'customer_table',
            resource:
              '//bigquery.googleapis.com/projects/p/datasets/d/tables/t',
            description: 'Table containing customer details.',
            location: 'us',
          },
        },
      },
    ];

    const result = await searchCatalog(
      {prompt: 'customer data', project_id: 'my-project'},
      deps(),
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      results: [
        {
          name: 'projects/p/locations/us/entryGroups/@bigquery/entries/e',
          display_name: 'customer_table',
          entry_type: 'projects/p/locations/l/entryTypes/bigquery-table',
          update_time: '2024-01-01 12:00:00+00:00',
          linked_resource:
            '//bigquery.googleapis.com/projects/p/datasets/d/tables/t',
          description: 'Table containing customer details.',
          location: 'us',
        },
      ],
    });
  });

  it('fills in the empty string for a field the entry omits', async () => {
    bigQueryState.searchResults = [{dataplexEntry: {}}, {}];

    const result = await searchCatalog(
      {prompt: 'anything', project_id: 'my-project'},
      deps(),
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      results: [
        {
          name: '',
          display_name: '',
          entry_type: '',
          update_time: '',
          linked_resource: '',
          description: '',
          location: '',
        },
      ],
    });
  });

  it('test_search_catalog_no_project_id', async () => {
    const result = await searchCatalog(
      {prompt: 'customer data', project_id: ''},
      deps(),
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'project_id must be provided.',
    });
    expect(bigQueryState.dataplexOptions).toHaveLength(0);
  });

  it('test_search_catalog_api_error', async () => {
    bigQueryState.searchError = Object.assign(new Error('permission denied'), {
      code: 7,
    });

    const result = await searchCatalog(
      {prompt: 'customer data', project_id: 'my-project'},
      deps(),
    );

    expect(result).toMatchObject({status: 'ERROR'});
    expect(result).toHaveProperty(
      'error_details',
      expect.stringContaining('Dataplex API Error:'),
    );
  });

  it('test_search_catalog_other_exception', async () => {
    bigQueryState.searchError = new Error('something else broke');

    const result = await searchCatalog(
      {prompt: 'customer data', project_id: 'my-project'},
      deps(),
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'something else broke',
    });
  });

  it('closes the Dataplex client on the success and the failure path', async () => {
    await searchCatalog({prompt: 'a', project_id: 'p'}, deps());
    expect(bigQueryState.dataplexCloseCount).toBe(1);

    bigQueryState.searchError = new Error('broke');
    await searchCatalog({prompt: 'a', project_id: 'p'}, deps());

    expect(bigQueryState.dataplexCloseCount).toBe(2);
  });

  it('test_search_catalog_no_app_name', async () => {
    await searchCatalog({prompt: 'a', project_id: 'p'}, deps());

    expect(bigQueryState.dataplexOptions[0]['grpc.primary_user_agent']).toBe(
      `${DP_USER_AGENT} search_catalog`,
    );
  });

  it('reports the application name in the user agent', async () => {
    await searchCatalog(
      {prompt: 'a', project_id: 'p'},
      deps({applicationName: 'my-agent'}),
    );

    expect(bigQueryState.dataplexOptions[0]['grpc.primary_user_agent']).toBe(
      `${DP_USER_AGENT} my-agent search_catalog`,
    );
  });

  it('test_search_catalog_default_location', async () => {
    await searchCatalog({prompt: 'a', project_id: 'my-project'}, deps());

    expect(lastSearchRequest()['name']).toBe(
      'projects/my-project/locations/global',
    );
  });

  it('test_search_catalog_settings_location', async () => {
    await searchCatalog(
      {prompt: 'a', project_id: 'my-project'},
      deps({location: 'us-central1'}),
    );

    expect(lastSearchRequest()['name']).toBe(
      'projects/my-project/locations/us-central1',
    );
  });

  it('prefers the location the call names over the configured one', async () => {
    await searchCatalog(
      {prompt: 'a', project_id: 'my-project', location: 'eu'},
      deps({location: 'us-central1'}),
    );

    expect(lastSearchRequest()['name']).toBe(
      'projects/my-project/locations/eu',
    );
  });

  it('returns one page, not every page the catalog matches', async () => {
    bigQueryState.searchResults = Array.from({length: 7}, (_, i) => ({
      dataplexEntry: {name: `entry-${i}`},
    }));

    const result = await searchCatalog(
      {prompt: 'a', project_id: 'my-project', page_size: 2},
      deps(),
    );

    expect(bigQueryState.searchCallOptions[0]).toEqual({autoPaginate: false});
    expect(result).toMatchObject({status: 'SUCCESS'});
    expect(
      (result as {results: unknown[]}).results.map(
        (entry) => (entry as {name: string}).name,
      ),
    ).toEqual(['entry-0', 'entry-1']);
  });

  it('caps an unbounded search at the default page size', async () => {
    bigQueryState.searchResults = Array.from({length: 25}, (_, i) => ({
      dataplexEntry: {name: `entry-${i}`},
    }));

    const result = await searchCatalog(
      {prompt: 'a', project_id: 'my-project'},
      deps(),
    );

    expect((result as {results: unknown[]}).results).toHaveLength(10);
  });

  it('asks for a semantic search of the requested page size', async () => {
    await searchCatalog(
      {prompt: 'a', project_id: 'my-project', page_size: 25},
      deps(),
    );

    expect(lastSearchRequest()).toMatchObject({
      pageSize: 25,
      semanticSearch: true,
    });
  });

  it('defaults the page size to ten', async () => {
    await searchCatalog({prompt: 'a', project_id: 'my-project'}, deps());

    expect(lastSearchRequest()['pageSize']).toBe(10);
  });
});

describe('constructSearchQuery', () => {
  it('test_search_catalog_query_construction', () => {
    expect(
      constructSearchQuery({prompt: 'sales', project_id: 'my-project'}),
    ).toBe('(sales) AND projectid="my-project" AND system=BIGQUERY');
  });

  it('test_search_catalog_multi_project_filter_semantic', () => {
    expect(
      constructSearchQuery({
        prompt: 'sales',
        project_id: 'my-project',
        project_ids_filter: ['p1', 'p2'],
      }),
    ).toBe(
      '(sales) AND (projectid="p1" OR projectid="p2") AND system=BIGQUERY',
    );
  });

  it('test_search_catalog_natural_language_semantic', () => {
    expect(
      constructSearchQuery({
        prompt: 'sales',
        project_id: 'my-project',
        dataset_ids_filter: ['d1', 'd2'],
        types_filter: ['TABLE'],
      }),
    ).toBe(
      '(sales) AND projectid="my-project" AND ' +
        '(linked_resource:"//bigquery.googleapis.com/projects/my-project' +
        '/datasets/d1/*" OR ' +
        'linked_resource:"//bigquery.googleapis.com/projects/my-project' +
        '/datasets/d2/*") AND type="TABLE" AND system=BIGQUERY',
    );
  });

  it('drops the prompt clause when the prompt is empty', () => {
    expect(constructSearchQuery({prompt: '', project_id: 'my-project'})).toBe(
      'projectid="my-project" AND system=BIGQUERY',
    );
  });

  it('contributes nothing for an empty value list', () => {
    expect(constructSearchQueryClause('projectid', '=', [])).toBe('');
  });

  it('ignores an empty filter list', () => {
    expect(
      constructSearchQuery({
        prompt: 'sales',
        project_id: 'my-project',
        project_ids_filter: [],
        dataset_ids_filter: [],
        types_filter: [],
      }),
    ).toBe('(sales) AND projectid="my-project" AND system=BIGQUERY');
  });
});
