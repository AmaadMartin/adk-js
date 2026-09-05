/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  MAX_DOWNLOADED_QUERY_RESULT_ROWS,
  executeSql,
} from '../../../src/tools/bigquery/query_tool.js';

const {BigQueryMock, fake} = vi.hoisted(() => {
  const fake = {
    rows: [] as Array<Record<string, unknown>>,
    failure: undefined as Error | undefined,
    queries: [] as Array<{query: string; options: {maxResults?: number}}>,
  };

  class FakeBigQuery {
    async query(
      query: string,
      options: {maxResults?: number},
    ): Promise<[Array<Record<string, unknown>>]> {
      fake.queries.push({query, options});
      if (fake.failure) throw fake.failure;
      return [fake.rows];
    }
  }

  return {BigQueryMock: FakeBigQuery, fake};
});

vi.mock('@google-cloud/bigquery', () => ({BigQuery: BigQueryMock}));

/** `count` distinct result rows. */
function rows(count: number): Array<Record<string, unknown>> {
  return Array.from({length: count}, (_unused, index) => ({index}));
}

describe('executeSql', () => {
  beforeEach(() => {
    fake.rows = [];
    fake.failure = undefined;
    fake.queries = [];
  });

  it('returns the rows the query produced', async () => {
    fake.rows = [{island: 'Dream', population: 124}];

    const result = await executeSql({
      project_id: 'my-project',
      query: 'SELECT island, COUNT(*) AS population FROM penguins',
    });

    expect(result).toEqual({rows: [{island: 'Dream', population: 124}]});
    expect(fake.queries).toEqual([
      {
        query: 'SELECT island, COUNT(*) AS population FROM penguins',
        options: {maxResults: 50},
      },
    ]);
  });

  it('caps the download at 50 rows', () => {
    expect(MAX_DOWNLOADED_QUERY_RESULT_ROWS).toBe(50);
  });

  it('flags the result as likely truncated at exactly the row cap', async () => {
    fake.rows = rows(MAX_DOWNLOADED_QUERY_RESULT_ROWS);

    const result = await executeSql({project_id: 'p', query: 'SELECT 1'});

    expect(result).toEqual({
      rows: fake.rows,
      result_is_likely_truncated: true,
    });
  });

  it('omits the truncation key one row below the cap', async () => {
    fake.rows = rows(MAX_DOWNLOADED_QUERY_RESULT_ROWS - 1);

    const result = await executeSql({project_id: 'p', query: 'SELECT 1'});

    expect(result).not.toHaveProperty('result_is_likely_truncated');
    expect(result).toEqual({rows: fake.rows});
  });

  it('omits the truncation key for an empty result', async () => {
    const result = await executeSql({project_id: 'p', query: 'SELECT 1'});

    expect(result).not.toHaveProperty('result_is_likely_truncated');
    expect(result).toEqual({rows: []});
  });

  it('reports a failing query as an error payload', async () => {
    fake.failure = new Error('Syntax error: Unexpected end of script');

    await expect(
      executeSql({project_id: 'p', query: 'SELECT'}),
    ).resolves.toEqual({
      status: 'ERROR',
      error_details: 'Syntax error: Unexpected end of script',
    });
  });
});
