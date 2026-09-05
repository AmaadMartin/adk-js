/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_search_tool.py`.
 *
 * Python's `Dataplex API Error:` prefix on a `GoogleAPICallError` is not
 * ported: the Node client raises no distinguishable class, and `GoogleTool`
 * reports the message either way.
 */

import type {CatalogServiceClient} from '@google-cloud/dataplex';
import {GoogleToolStatus} from '@google/adk';
import {getDataplexCatalogClient} from '@google/adk/integrations/bigquery/client.js';
import {createBigQueryToolSettings} from '@google/adk/integrations/bigquery/config.js';
import {
  DEFAULT_SEARCH_PAGE_SIZE,
  searchCatalog,
} from '@google/adk/integrations/bigquery/search_tool.js';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {fakeState, resetFakes} from './bigquery_fakes.js';

vi.mock('@google-cloud/dataplex', async () => {
  const {FakeCatalogServiceClient} = await import('./bigquery_fakes.js');
  return {CatalogServiceClient: FakeCatalogServiceClient};
});

const ENTRY = {
  dataplexEntry: {
    name: 'projects/my-project/locations/us/entryGroups/@bigquery/entries/entry-id',
    entryType: 'projects/p/locations/l/entryTypes/bigquery-table',
    updateTime: '2024-01-01 12:00:00+00:00',
    entrySource: {
      displayName: 'customer_table',
      resource:
        '//bigquery.googleapis.com/projects/my-project/datasets/d/tables/customer_table',
      description: 'Table containing customer details.',
      location: 'us',
    },
  },
};

function client(): Promise<CatalogServiceClient> {
  return getDataplexCatalogClient({});
}

/** The request the tool sent to Dataplex. */
function lastSearch(): Record<string, unknown> {
  const {searches} = fakeState.dataplex.calls;
  return searches[searches.length - 1];
}

describe('searchCatalog', () => {
  beforeEach(() => {
    resetFakes({}, {searchResults: [ENTRY]});
  });

  it('returns the entries Dataplex matched', async () => {
    const result = await searchCatalog(
      await client(),
      {
        prompt: 'Search for tables related to customer data',
        projectId: 'my-project',
      },
      createBigQueryToolSettings(),
    );

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      results: [
        {
          name: 'projects/my-project/locations/us/entryGroups/@bigquery/entries/entry-id',
          display_name: 'customer_table',
          entry_type: 'projects/p/locations/l/entryTypes/bigquery-table',
          update_time: '2024-01-01 12:00:00+00:00',
          linked_resource:
            '//bigquery.googleapis.com/projects/my-project/datasets/d/tables/customer_table',
          description: 'Table containing customer details.',
          location: 'us',
        },
      ],
    });
  });

  it('scopes the search to BigQuery in the caller project', async () => {
    await searchCatalog(
      await client(),
      {prompt: 'customer data', projectId: 'my-project'},
      createBigQueryToolSettings(),
    );

    expect(lastSearch()).toEqual({
      name: 'projects/my-project/locations/global',
      query: '(customer data) AND projectid="my-project" AND system=BIGQUERY',
      pageSize: DEFAULT_SEARCH_PAGE_SIZE,
      semanticSearch: true,
    });
  });

  it('joins several projects with OR', async () => {
    await searchCatalog(
      await client(),
      {
        prompt: 'orders',
        projectId: 'my-project',
        projectIdsFilter: ['a', 'b'],
      },
      createBigQueryToolSettings(),
    );

    expect(lastSearch()['query']).toBe(
      '(orders) AND (projectid="a" OR projectid="b") AND system=BIGQUERY',
    );
  });

  it('matches every dataset across every filtered project', async () => {
    await searchCatalog(
      await client(),
      {
        prompt: '',
        projectId: 'my-project',
        datasetIdsFilter: ['sales', 'ops'],
      },
      createBigQueryToolSettings(),
    );

    expect(lastSearch()['query']).toBe(
      'projectid="my-project" AND' +
        ' (linked_resource:"//bigquery.googleapis.com/projects/my-project/datasets/sales/*"' +
        ' OR linked_resource:"//bigquery.googleapis.com/projects/my-project/datasets/ops/*")' +
        ' AND system=BIGQUERY',
    );
  });

  it('filters by entry type', async () => {
    await searchCatalog(
      await client(),
      {prompt: 'p', projectId: 'my-project', typesFilter: ['TABLE']},
      createBigQueryToolSettings(),
    );

    expect(lastSearch()['query']).toContain('type="TABLE"');
  });

  it('searches the configured location when the model names none', async () => {
    await searchCatalog(
      await client(),
      {prompt: 'p', projectId: 'my-project'},
      createBigQueryToolSettings({location: 'us-central1'}),
    );

    expect(lastSearch()['name']).toBe(
      'projects/my-project/locations/us-central1',
    );
  });

  it('prefers the location the model named', async () => {
    await searchCatalog(
      await client(),
      {prompt: 'p', projectId: 'my-project', location: 'eu'},
      createBigQueryToolSettings({location: 'us-central1'}),
    );

    expect(lastSearch()['name']).toBe('projects/my-project/locations/eu');
  });

  it('keeps the page size the model asked for', async () => {
    await searchCatalog(
      await client(),
      {prompt: 'p', projectId: 'my-project', pageSize: 3},
      createBigQueryToolSettings(),
    );

    expect(lastSearch()['pageSize']).toBe(3);
  });

  it('refuses a search with no project', async () => {
    await expect(
      searchCatalog(
        await client(),
        {prompt: 'p', projectId: ''},
        createBigQueryToolSettings(),
      ),
    ).rejects.toThrow('project_id must be provided.');
    expect(fakeState.dataplex.calls.searches).toHaveLength(0);
  });

  it('fills in the fields an entry left unset', async () => {
    resetFakes({}, {searchResults: [{}]});

    const result = await searchCatalog(
      await client(),
      {prompt: 'p', projectId: 'my-project'},
      createBigQueryToolSettings(),
    );

    expect(result.results).toEqual([
      {
        name: '',
        display_name: '',
        entry_type: '',
        update_time: '',
        linked_resource: '',
        description: '',
        location: '',
      },
    ]);
  });

  it('lets a Dataplex failure out, for GoogleTool to shape', async () => {
    resetFakes({}, {searchError: new Error('Permission denied on dataplex')});

    await expect(
      searchCatalog(
        await client(),
        {prompt: 'p', projectId: 'my-project'},
        createBigQueryToolSettings(),
      ),
    ).rejects.toThrow('Permission denied on dataplex');
  });
});
