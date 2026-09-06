/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
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

const DATABASE_ARGS = {
  project_id: 'my-project',
  instance_id: 'my-instance',
  database_id: 'my-database',
};

async function toolNamed(
  name: string,
  settings = new SpannerToolSettings(),
): Promise<BaseTool> {
  const tools = await new SpannerToolset({
    spannerToolSettings: settings,
  }).getTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(`no tool named ${name}`);
  }
  return tool;
}

async function run(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = await toolNamed(name);
  return tool.runAsync({args, toolContext: createToolContext()});
}

describe('spanner_list_table_names', () => {
  beforeEach(() => {
    resetSpannerFake();
  });

  it('returns the table names of the default schema', async () => {
    respondTo(/INFORMATION_SCHEMA\.TABLES/, [
      positionalRow('Albums'),
      positionalRow('Singers'),
    ]);

    await expect(
      run('spanner_list_table_names', DATABASE_ARGS),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      results: ['Albums', 'Singers'],
    });
    expect(spannerFake.queries[0]?.params).toEqual({named_schema: ''});
  });

  it('treats the _default alias as the unnamed schema', async () => {
    await run('spanner_list_table_names', {
      ...DATABASE_ARGS,
      named_schema: '_default',
    });

    expect(spannerFake.queries[0]?.params).toEqual({named_schema: ''});
  });

  it('queries a named schema as given', async () => {
    await run('spanner_list_table_names', {
      ...DATABASE_ARGS,
      named_schema: 'catalog',
    });

    expect(spannerFake.queries[0]?.params).toEqual({named_schema: 'catalog'});
  });

  it('runs against a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';
    respondTo(/INFORMATION_SCHEMA\.TABLES/, [positionalRow('albums')]);

    await expect(
      run('spanner_list_table_names', DATABASE_ARGS),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      results: ['albums'],
    });
  });

  it('reports a query failure', async () => {
    spannerFake.failQuery = {
      match: /INFORMATION_SCHEMA/,
      error: new Error('Database not found: my-database'),
    };

    await expect(
      run('spanner_list_table_names', DATABASE_ARGS),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'Database not found: my-database',
    });
  });

  it('closes the client even when the query fails', async () => {
    spannerFake.failQuery = {
      match: /INFORMATION_SCHEMA/,
      error: new Error('Database not found: my-database'),
    };

    await run('spanner_list_table_names', DATABASE_ARGS);

    expect(spannerFake.clients[0]?.closeCount).toBe(1);
    expect(spannerFake.databases[0]?.closeCount).toBe(1);
  });
});

describe('spanner_list_named_schemas', () => {
  beforeEach(() => {
    resetSpannerFake();
  });

  it('returns the named schemas', async () => {
    respondTo(/INFORMATION_SCHEMA\.SCHEMATA/, [
      positionalRow('catalog'),
      positionalRow('sales'),
    ]);

    await expect(
      run('spanner_list_named_schemas', DATABASE_ARGS),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      results: ['catalog', 'sales'],
    });
  });

  it('excludes the built-in schemas in the query', async () => {
    await run('spanner_list_named_schemas', DATABASE_ARGS);

    expect(spannerFake.queries[0]?.sql).toContain(
      "SCHEMA_NAME NOT IN ('', 'INFORMATION_SCHEMA', 'SPANNER_SYS')",
    );
  });

  it('rejects a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    await expect(
      run('spanner_list_named_schemas', DATABASE_ARGS),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'PostgreSQL dialect is not supported.',
    });
    expect(spannerFake.queries).toEqual([]);
  });
});

describe('spanner_list_table_indexes', () => {
  beforeEach(() => {
    resetSpannerFake();
  });

  it('labels each row with the index columns', async () => {
    respondTo(/INFORMATION_SCHEMA\.INDEXES/, [
      positionalRow('PRIMARY_KEY', '', 'PRIMARY_KEY', '', true, false, null),
    ]);

    await expect(
      run('spanner_list_table_indexes', {...DATABASE_ARGS, table_id: 'Albums'}),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      results: [
        {
          INDEX_NAME: 'PRIMARY_KEY',
          TABLE_SCHEMA: '',
          INDEX_TYPE: 'PRIMARY_KEY',
          PARENT_TABLE_NAME: '',
          IS_UNIQUE: true,
          IS_NULL_FILTERED: false,
          INDEX_STATE: null,
        },
      ],
    });
    expect(spannerFake.queries[0]?.params).toEqual({table_id: 'Albums'});
  });

  it('falls back to the string form of a row it cannot serialize', async () => {
    respondTo(/INFORMATION_SCHEMA\.INDEXES/, [
      positionalRow('IDX', '', 'INDEX', '', true, false, 1n),
    ]);

    const result = await run('spanner_list_table_indexes', {
      ...DATABASE_ARGS,
      table_id: 'Albums',
    });

    expect(result).toEqual({
      status: SpannerToolStatus.SUCCESS,
      results: [
        "{ INDEX_NAME: 'IDX', TABLE_SCHEMA: '', INDEX_TYPE: 'INDEX', PARENT_TABLE_NAME: '', IS_UNIQUE: true, IS_NULL_FILTERED: false, INDEX_STATE: 1n }",
      ],
    });
  });

  it('rejects a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    await expect(
      run('spanner_list_table_indexes', {...DATABASE_ARGS, table_id: 'Albums'}),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'PostgreSQL dialect is not supported.',
    });
  });
});

describe('spanner_list_table_index_columns', () => {
  beforeEach(() => {
    resetSpannerFake();
  });

  it('labels each row with the index column keys', async () => {
    respondTo(/INFORMATION_SCHEMA\.INDEX_COLUMNS/, [
      positionalRow('PRIMARY_KEY', '', 'SingerId', 1, 'NO', 'INT64'),
    ]);

    await expect(
      run('spanner_list_table_index_columns', {
        ...DATABASE_ARGS,
        table_id: 'Albums',
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      results: [
        {
          INDEX_NAME: 'PRIMARY_KEY',
          TABLE_SCHEMA: '',
          COLUMN_NAME: 'SingerId',
          ORDINAL_POSITION: 1,
          IS_NULLABLE: 'NO',
          SPANNER_TYPE: 'INT64',
        },
      ],
    });
  });

  it('rejects a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    await expect(
      run('spanner_list_table_index_columns', {
        ...DATABASE_ARGS,
        table_id: 'Albums',
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'PostgreSQL dialect is not supported.',
    });
  });
});

describe('spanner_get_table_schema', () => {
  beforeEach(() => {
    resetSpannerFake();
    respondTo(/INFORMATION_SCHEMA\.COLUMNS/, [
      positionalRow(
        'SingerId',
        '',
        'INT64',
        1,
        null,
        'NO',
        'NEVER',
        null,
        null,
      ),
      positionalRow(
        'Title',
        '',
        'STRING(MAX)',
        2,
        null,
        'YES',
        'NEVER',
        null,
        null,
      ),
    ]);
    respondTo(/INFORMATION_SCHEMA\.KEY_COLUMN_USAGE/, [
      positionalRow('SingerId', 'PK_Albums', 1, null),
    ]);
    respondTo(/INFORMATION_SCHEMA\.TABLES/, [
      positionalRow(
        '',
        'Albums',
        'BASE TABLE',
        null,
        null,
        'COMMITTED',
        null,
        null,
      ),
    ]);
  });

  it('returns the columns, their key usage and the table metadata', async () => {
    await expect(
      run('spanner_get_table_schema', {
        ...DATABASE_ARGS,
        table_name: 'Albums',
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.SUCCESS,
      results: {
        schema: {
          SingerId: {
            TABLE_SCHEMA: '',
            SPANNER_TYPE: 'INT64',
            ORDINAL_POSITION: 1,
            COLUMN_DEFAULT: null,
            IS_NULLABLE: 'NO',
            IS_GENERATED: 'NEVER',
            GENERATION_EXPRESSION: null,
            IS_STORED: null,
            KEY_COLUMN_USAGE: [
              {
                CONSTRAINT_NAME: 'PK_Albums',
                ORDINAL_POSITION: 1,
                POSITION_IN_UNIQUE_CONSTRAINT: null,
              },
            ],
          },
          Title: {
            TABLE_SCHEMA: '',
            SPANNER_TYPE: 'STRING(MAX)',
            ORDINAL_POSITION: 2,
            COLUMN_DEFAULT: null,
            IS_NULLABLE: 'YES',
            IS_GENERATED: 'NEVER',
            GENERATION_EXPRESSION: null,
            IS_STORED: null,
          },
        },
        metadata: [
          {
            TABLE_SCHEMA: '',
            TABLE_NAME: 'Albums',
            TABLE_TYPE: 'BASE TABLE',
            PARENT_TABLE_NAME: null,
            ON_DELETE_ACTION: null,
            SPANNER_STATE: 'COMMITTED',
            INTERLEAVE_TYPE: null,
            ROW_DELETION_POLICY_EXPRESSION: null,
          },
        ],
      },
    });
  });

  it('passes the table name and the schema as query parameters', async () => {
    await run('spanner_get_table_schema', {
      ...DATABASE_ARGS,
      table_name: 'Albums',
      named_schema: 'catalog',
    });

    expect(spannerFake.queries[0]?.params).toEqual({
      table_name: 'Albums',
      named_schema: 'catalog',
    });
    expect(spannerFake.queries).toHaveLength(3);
  });

  it('ignores key usage for a column the schema query did not return', async () => {
    respondTo(/INFORMATION_SCHEMA\.KEY_COLUMN_USAGE/, [
      positionalRow('Unknown', 'PK_Albums', 1, null),
    ]);
    spannerFake.responses.reverse();

    const result = await run('spanner_get_table_schema', {
      ...DATABASE_ARGS,
      table_name: 'Albums',
    });

    expect(result).toMatchObject({status: SpannerToolStatus.SUCCESS});
    expect(JSON.stringify(result)).not.toContain('Unknown');
  });

  it('falls back to the string form of a result it cannot serialize', async () => {
    respondTo(/INFORMATION_SCHEMA\.COLUMNS/, [
      positionalRow(
        'SingerId',
        '',
        'INT64',
        1n,
        null,
        'NO',
        'NEVER',
        null,
        null,
      ),
    ]);
    spannerFake.responses.reverse();

    await expect(
      run('spanner_get_table_schema', {
        ...DATABASE_ARGS,
        table_name: 'Albums',
      }),
    ).resolves.toMatchObject({
      status: SpannerToolStatus.SUCCESS,
    });
    const {results} = (await run('spanner_get_table_schema', {
      ...DATABASE_ARGS,
      table_name: 'Albums',
    })) as {results: string};
    expect(results).toContain('ORDINAL_POSITION: 1n');
  });

  it('rejects a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    await expect(
      run('spanner_get_table_schema', {
        ...DATABASE_ARGS,
        table_name: 'Albums',
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'PostgreSQL dialect is not supported.',
    });
  });
});
