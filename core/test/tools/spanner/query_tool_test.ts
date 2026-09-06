/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  QueryResultMode,
  SpannerToolset,
  SpannerToolSettings,
  SpannerToolStatus,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createToolContext,
  positionalRow,
  resetSpannerFake,
  respondTo,
  spannerFake,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner', async () => {
  const utils = await import('./spanner_test_utils.js');
  return utils.spannerModuleFake();
});

const QUERY_ARGS = {
  project_id: 'my-project',
  instance_id: 'my-instance',
  database_id: 'my-database',
  query: 'SELECT name FROM Singers',
};

async function executeSqlTool(
  settings = new SpannerToolSettings(),
): Promise<BaseTool> {
  const tools = await new SpannerToolset({
    spannerToolSettings: settings,
  }).getTools();
  const tool = tools.find(
    (candidate) => candidate.name === 'spanner_execute_sql',
  );
  if (!tool) {
    expect.fail('the toolset did not expose spanner_execute_sql');
  }
  return tool;
}

async function runExecuteSql(settings?: SpannerToolSettings): Promise<unknown> {
  const tool = await executeSqlTool(settings);
  return tool.runAsync({args: QUERY_ARGS, toolContext: createToolContext()});
}

describe('spanner_execute_sql', () => {
  beforeEach(() => {
    resetSpannerFake();
  });

  it('returns each row as its column values by default', async () => {
    respondTo(/SELECT name/, [positionalRow('Alice'), positionalRow('Bob')]);

    await expect(runExecuteSql()).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      rows: [['Alice'], ['Bob']],
    });
    expect(spannerFake.queries[0]?.json).toBe(false);
    expect(spannerFake.queries[0]?.streamed).toBe(true);
  });

  it('returns each row keyed by column name in dict list mode', async () => {
    respondTo(/SELECT name/, [{name: 'Alice'}, {name: 'Bob'}]);

    await expect(
      runExecuteSql(
        new SpannerToolSettings({queryResultMode: QueryResultMode.DICT_LIST}),
      ),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      rows: [{name: 'Alice'}, {name: 'Bob'}],
    });
    expect(spannerFake.queries[0]?.json).toBe(true);
  });

  it('returns no truncation flag when the result fits under the cap', async () => {
    respondTo(/SELECT name/, [positionalRow('Alice')]);

    const result = await runExecuteSql(
      new SpannerToolSettings({maxExecutedQueryResultRows: 2}),
    );

    expect(result).toEqual({
      status: SpannerToolStatus.SUCCESS,
      rows: [['Alice']],
    });
  });

  it('stops at the row cap and flags the result as truncated', async () => {
    respondTo(/SELECT name/, [
      positionalRow('Alice'),
      positionalRow('Bob'),
      positionalRow('Carol'),
    ]);

    await expect(
      runExecuteSql(new SpannerToolSettings({maxExecutedQueryResultRows: 2})),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      rows: [['Alice'], ['Bob']],
      result_is_likely_truncated: true,
    });
  });

  it('flags the result when it stops on the last row', async () => {
    respondTo(/SELECT name/, [positionalRow('Alice'), positionalRow('Bob')]);

    await expect(
      runExecuteSql(new SpannerToolSettings({maxExecutedQueryResultRows: 2})),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      rows: [['Alice'], ['Bob']],
      result_is_likely_truncated: true,
    });
  });

  it.each([0, -1])('falls back to 50 rows for a cap of %i', async (cap) => {
    respondTo(
      /SELECT name/,
      Array.from({length: 60}, (_, index) => positionalRow(`row-${index}`)),
    );

    const result = await runExecuteSql(
      new SpannerToolSettings({maxExecutedQueryResultRows: cap}),
    );

    expect(result).toMatchObject({result_is_likely_truncated: true});
    expect((result as {rows: unknown[]}).rows).toHaveLength(50);
  });

  it('falls back to the string form of a row it cannot serialize', async () => {
    respondTo(/SELECT name/, [positionalRow(1n)]);

    await expect(runExecuteSql()).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      rows: ['[ 1n ]'],
    });
  });

  it('opens the database with the configured role', async () => {
    await runExecuteSql(new SpannerToolSettings({databaseRole: 'reader'}));

    expect(spannerFake.databases[0]?.databaseRole).toBe('reader');
  });

  it('opens the database with no role by default', async () => {
    await runExecuteSql();

    expect(spannerFake.databases[0]?.databaseRole).toBeUndefined();
  });

  it('rejects a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    await expect(runExecuteSql()).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'PostgreSQL dialect is not supported.',
    });
    expect(spannerFake.queries).toEqual([]);
  });

  it('reports a query failure', async () => {
    spannerFake.failQuery = {
      match: /SELECT name/,
      error: new Error('Table not found: Singers'),
    };

    await expect(runExecuteSql()).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'Table not found: Singers',
    });
    expect(spannerFake.clients[0]?.closeCount).toBe(1);
  });

  it('describes the default row shape', async () => {
    const tool = await executeSqlTool();
    expect(tool.description).toContain('list of its column values');
  });

  it('describes the dict list row shape', async () => {
    const tool = await executeSqlTool(
      new SpannerToolSettings({queryResultMode: QueryResultMode.DICT_LIST}),
    );
    expect(tool.description).toContain('keyed by column name');
  });
});
