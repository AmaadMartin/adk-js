/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  QueryResultMode,
  SpannerToolset,
  SpannerToolSettings,
} from '@google/adk/tools/spanner';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  errorOf,
  FakeRow,
  runTool,
  spannerFake,
  successOf,
  testCredentialsConfig,
  valueRow,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner', async () => {
  const {fakeSpannerModule} = await import('./spanner_test_utils.js');
  return fakeSpannerModule;
});

const QUERY_ARGS = {
  project_id: 'p',
  instance_id: 'i',
  database_id: 'd',
  query: 'SELECT name, rating FROM hotels',
};

function toolset(settings?: SpannerToolSettings): SpannerToolset {
  return new SpannerToolset({
    credentialsConfig: testCredentialsConfig(),
    spannerToolSettings: settings,
  });
}

async function executeSql(
  settings?: SpannerToolSettings,
  args: Record<string, unknown> = QUERY_ARGS,
): Promise<unknown> {
  return runTool(toolset(settings), 'spanner_execute_sql', args);
}

/** Answers the query with `count` rows of one column. */
function rows(count: number): FakeRow[] {
  return Array.from({length: count}, (_, index) => valueRow(index));
}

async function descriptionOf(settings?: SpannerToolSettings): Promise<string> {
  const tools = await toolset(settings).getTools();
  const tool = tools.find((each) => each.name === 'spanner_execute_sql');
  if (!tool) {
    return expect.fail('the toolset exposes no spanner_execute_sql');
  }
  return tool.description;
}

describe('spanner_execute_sql', () => {
  beforeEach(() => {
    spannerFake.reset();
  });

  it('returns each row as its list of column values', async () => {
    spannerFake.responses = [
      {match: 'FROM hotels', rows: [valueRow('The Hotel', 4.1)]},
    ];

    const result = await executeSql();

    expect(successOf(result)).toEqual({
      status: 'SUCCESS',
      rows: [['The Hotel', 4.1]],
    });
  });

  it('streams the rows rather than buffering the result set', async () => {
    await executeSql();

    expect(spannerFake.lastQuery()).toMatchObject({
      sql: QUERY_ARGS.query,
      json: false,
      streamed: true,
    });
  });

  it('asks the client for objects in dict-list mode', async () => {
    spannerFake.responses = [
      {match: 'FROM hotels', rows: [{name: 'The Hotel', rating: 4.1}]},
    ];

    const result = await executeSql({
      queryResultMode: QueryResultMode.DICT_LIST,
    });

    expect(spannerFake.lastQuery().json).toBe(true);
    expect(successOf(result)['rows']).toEqual([
      {name: 'The Hotel', rating: 4.1},
    ]);
  });

  it('renders a row JSON cannot serialize', async () => {
    spannerFake.responses = [{match: 'FROM hotels', rows: [valueRow(1n)]}];

    const result = await executeSql();

    expect(successOf(result)['rows']).toEqual([expect.stringContaining('1n')]);
  });

  it('tells the model the row shape it will get by default', async () => {
    expect(await descriptionOf()).toContain('list of its column values');
  });

  it('tells the model the row shape of dict-list mode', async () => {
    const description = await descriptionOf({
      queryResultMode: QueryResultMode.DICT_LIST,
    });

    expect(description).toContain('object keyed by column name');
    expect(description).not.toContain('list of its column values');
  });

  describe('the row budget', () => {
    it('flags a result that filled the budget exactly', async () => {
      spannerFake.responses = [{match: 'FROM hotels', rows: rows(3)}];

      const result = await executeSql({maxExecutedQueryResultRows: 3});

      expect(successOf(result)).toEqual({
        status: 'SUCCESS',
        rows: [[0], [1], [2]],
        result_is_likely_truncated: true,
      });
    });

    it('does not flag a result one row short of the budget', async () => {
      spannerFake.responses = [{match: 'FROM hotels', rows: rows(2)}];

      const result = await executeSql({maxExecutedQueryResultRows: 3});

      expect(successOf(result)).toEqual({
        status: 'SUCCESS',
        rows: [[0], [1]],
      });
    });

    it('stops reading once the budget is spent', async () => {
      spannerFake.responses = [{match: 'FROM hotels', rows: rows(10)}];

      const result = await executeSql({maxExecutedQueryResultRows: 2});

      expect(successOf(result)['rows']).toEqual([[0], [1]]);
    });

    it('defaults to fifty rows', async () => {
      spannerFake.responses = [{match: 'FROM hotels', rows: rows(60)}];

      const result = await executeSql();

      expect(successOf(result)['rows']).toHaveLength(50);
    });

    it.each([0, -5])(
      'falls back to fifty rows for a budget of %i',
      async (maxExecutedQueryResultRows) => {
        spannerFake.responses = [{match: 'FROM hotels', rows: rows(60)}];

        const result = await executeSql({maxExecutedQueryResultRows});

        expect(successOf(result)['rows']).toHaveLength(50);
      },
    );

    it('returns no rows and no flag for an empty result', async () => {
      const result = await executeSql();

      expect(successOf(result)).toEqual({status: 'SUCCESS', rows: []});
    });
  });

  it('runs under no database role by default', async () => {
    await executeSql();

    expect(spannerFake.databases[0].databaseRole).toBeUndefined();
  });

  it('runs under the database role the settings name', async () => {
    await executeSql({databaseRole: 'analyst'});

    expect(spannerFake.databases[0].databaseRole).toBe('analyst');
  });

  it('refuses a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    expect(errorOf(await executeSql())).toBe(
      'PostgreSQL dialect is not supported.',
    );
  });

  it('reports a rejected query as an error', async () => {
    spannerFake.failures.run = new Error('syntax error near SELECT');

    expect(errorOf(await executeSql())).toBe('syntax error near SELECT');
  });

  it('closes the client after a rejected query', async () => {
    spannerFake.failures.run = new Error('syntax error near SELECT');

    await executeSql();

    expect(spannerFake.closedClients).toBe(1);
    expect(spannerFake.closedDatabases).toBe(1);
    expect(spannerFake.endedSnapshots).toBe(1);
  });
});
