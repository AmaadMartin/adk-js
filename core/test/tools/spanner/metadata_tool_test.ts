/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SpannerToolset} from '@google/adk/tools/spanner';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  errorOf,
  namedRow,
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

const DATABASE_ARGS = {project_id: 'p', instance_id: 'i', database_id: 'd'};

function toolset(): SpannerToolset {
  return new SpannerToolset({credentialsConfig: testCredentialsConfig()});
}

describe('spanner_list_table_names', () => {
  beforeEach(() => {
    spannerFake.reset();
  });

  it('lists the tables of the default GoogleSQL schema', async () => {
    spannerFake.responses = [
      {
        match: 'INFORMATION_SCHEMA.TABLES',
        rows: [valueRow('Singers'), valueRow('Albums')],
      },
    ];

    const result = await runTool(
      toolset(),
      'spanner_list_table_names',
      DATABASE_ARGS,
    );

    expect(successOf(result)['results']).toEqual(['Singers', 'Albums']);
    expect(spannerFake.lastQuery()).toMatchObject({
      params: {schema: ''},
      types: {schema: 'string'},
    });
    expect(spannerFake.lastQuery().sql).toContain(
      "WHERE TABLE_SCHEMA = @schema AND SPANNER_STATE = 'COMMITTED'",
    );
  });

  it('lists the tables of a named schema', async () => {
    await runTool(toolset(), 'spanner_list_table_names', {
      ...DATABASE_ARGS,
      named_schema: 'sales',
    });

    expect(spannerFake.lastQuery().params).toEqual({schema: 'sales'});
  });

  it('resolves the "_default" schema the model may send', async () => {
    await runTool(toolset(), 'spanner_list_table_names', {
      ...DATABASE_ARGS,
      named_schema: '_default',
    });

    expect(spannerFake.lastQuery().params).toEqual({schema: ''});
  });

  it('reads the public schema of a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    const result = await runTool(
      toolset(),
      'spanner_list_table_names',
      DATABASE_ARGS,
    );

    expect(successOf(result)['results']).toEqual([]);
    expect(spannerFake.lastQuery()).toMatchObject({
      params: {p1: 'public'},
      types: {p1: 'string'},
    });
    expect(spannerFake.lastQuery().sql).toContain('WHERE TABLE_SCHEMA = $1');
  });

  it('reports a rejected read as an error', async () => {
    spannerFake.failures.run = new Error('permission denied');

    const result = await runTool(
      toolset(),
      'spanner_list_table_names',
      DATABASE_ARGS,
    );

    expect(errorOf(result)).toBe('permission denied');
  });

  it('closes the client even when the read is rejected', async () => {
    spannerFake.failures.run = new Error('permission denied');

    await runTool(toolset(), 'spanner_list_table_names', DATABASE_ARGS);

    expect(spannerFake.closedClients).toBe(1);
    expect(spannerFake.closedDatabases).toBe(1);
    expect(spannerFake.endedSnapshots).toBe(1);
  });
});

describe('spanner_list_named_schemas', () => {
  beforeEach(() => {
    spannerFake.reset();
  });

  it('lists the schemas the database defines', async () => {
    spannerFake.responses = [
      {match: 'INFORMATION_SCHEMA.SCHEMATA', rows: [valueRow('sales')]},
    ];

    const result = await runTool(
      toolset(),
      'spanner_list_named_schemas',
      DATABASE_ARGS,
    );

    expect(successOf(result)['results']).toEqual(['sales']);
    expect(spannerFake.lastQuery().params).toBeUndefined();
  });

  it('refuses a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    const result = await runTool(
      toolset(),
      'spanner_list_named_schemas',
      DATABASE_ARGS,
    );

    expect(errorOf(result)).toBe('PostgreSQL dialect is not supported.');
  });
});

describe('spanner_list_table_indexes', () => {
  beforeEach(() => {
    spannerFake.reset();
  });

  it('labels each index row', async () => {
    spannerFake.responses = [
      {
        match: 'INFORMATION_SCHEMA.INDEXES',
        rows: [
          namedRow({
            INDEX_NAME: 'PRIMARY_KEY',
            TABLE_SCHEMA: '',
            INDEX_TYPE: 'PRIMARY_KEY',
            PARENT_TABLE_NAME: '',
            IS_UNIQUE: true,
            IS_NULL_FILTERED: false,
            INDEX_STATE: null,
          }),
        ],
      },
    ];

    const result = await runTool(toolset(), 'spanner_list_table_indexes', {
      ...DATABASE_ARGS,
      table_id: 'Singers',
    });

    expect(successOf(result)['results']).toEqual([
      {
        INDEX_NAME: 'PRIMARY_KEY',
        TABLE_SCHEMA: '',
        INDEX_TYPE: 'PRIMARY_KEY',
        PARENT_TABLE_NAME: '',
        IS_UNIQUE: true,
        IS_NULL_FILTERED: false,
        INDEX_STATE: null,
      },
    ]);
    expect(spannerFake.lastQuery()).toMatchObject({
      params: {table_id: 'Singers'},
      types: {table_id: 'string'},
    });
  });

  it('renders a row JSON cannot serialize', async () => {
    spannerFake.responses = [
      {
        match: 'INFORMATION_SCHEMA.INDEXES',
        rows: [
          namedRow({
            INDEX_NAME: 'IDX',
            TABLE_SCHEMA: '',
            INDEX_TYPE: 'INDEX',
            PARENT_TABLE_NAME: '',
            IS_UNIQUE: true,
            IS_NULL_FILTERED: false,
            INDEX_STATE: 1n,
          }),
        ],
      },
    ];

    const result = await runTool(toolset(), 'spanner_list_table_indexes', {
      ...DATABASE_ARGS,
      table_id: 'Singers',
    });

    expect(successOf(result)['results']).toEqual([
      expect.stringContaining("INDEX_NAME: 'IDX'"),
    ]);
  });

  it('refuses a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    const result = await runTool(toolset(), 'spanner_list_table_indexes', {
      ...DATABASE_ARGS,
      table_id: 'Singers',
    });

    expect(errorOf(result)).toBe('PostgreSQL dialect is not supported.');
  });
});

describe('spanner_list_table_index_columns', () => {
  beforeEach(() => {
    spannerFake.reset();
  });

  it('labels each index column row', async () => {
    spannerFake.responses = [
      {
        match: 'INFORMATION_SCHEMA.INDEX_COLUMNS',
        rows: [
          namedRow({
            INDEX_NAME: 'PRIMARY_KEY',
            TABLE_SCHEMA: '',
            COLUMN_NAME: 'SingerId',
            ORDINAL_POSITION: 1,
            IS_NULLABLE: 'NO',
            SPANNER_TYPE: 'INT64',
          }),
        ],
      },
    ];

    const result = await runTool(
      toolset(),
      'spanner_list_table_index_columns',
      {...DATABASE_ARGS, table_id: 'Singers'},
    );

    expect(successOf(result)['results']).toEqual([
      {
        INDEX_NAME: 'PRIMARY_KEY',
        TABLE_SCHEMA: '',
        COLUMN_NAME: 'SingerId',
        ORDINAL_POSITION: 1,
        IS_NULLABLE: 'NO',
        SPANNER_TYPE: 'INT64',
      },
    ]);
  });

  it('renders a row JSON cannot serialize', async () => {
    spannerFake.responses = [
      {
        match: 'INFORMATION_SCHEMA.INDEX_COLUMNS',
        rows: [
          namedRow({
            INDEX_NAME: 'PRIMARY_KEY',
            TABLE_SCHEMA: '',
            COLUMN_NAME: 'SingerId',
            ORDINAL_POSITION: 1n,
            IS_NULLABLE: 'NO',
            SPANNER_TYPE: 'INT64',
          }),
        ],
      },
    ];

    const result = await runTool(
      toolset(),
      'spanner_list_table_index_columns',
      {...DATABASE_ARGS, table_id: 'Singers'},
    );

    expect(successOf(result)['results']).toEqual([
      expect.stringContaining("COLUMN_NAME: 'SingerId'"),
    ]);
  });

  it('refuses a PostgreSQL database', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    const result = await runTool(
      toolset(),
      'spanner_list_table_index_columns',
      {...DATABASE_ARGS, table_id: 'Singers'},
    );

    expect(errorOf(result)).toBe('PostgreSQL dialect is not supported.');
  });
});

describe('spanner_get_table_schema', () => {
  const SCHEMA_ARGS = {...DATABASE_ARGS, table_name: 'Singers'};

  beforeEach(() => {
    spannerFake.reset();
    spannerFake.responses = [
      {
        match: 'INFORMATION_SCHEMA.COLUMNS',
        rows: [
          namedRow({
            COLUMN_NAME: 'SingerId',
            TABLE_SCHEMA: '',
            SPANNER_TYPE: 'INT64',
            ORDINAL_POSITION: 1,
            COLUMN_DEFAULT: null,
            IS_NULLABLE: 'NO',
            IS_GENERATED: 'NEVER',
            GENERATION_EXPRESSION: null,
            IS_STORED: null,
          }),
          namedRow({
            COLUMN_NAME: 'Name',
            TABLE_SCHEMA: '',
            SPANNER_TYPE: 'STRING(MAX)',
            ORDINAL_POSITION: 2,
            COLUMN_DEFAULT: null,
            IS_NULLABLE: 'YES',
            IS_GENERATED: 'NEVER',
            GENERATION_EXPRESSION: null,
            IS_STORED: null,
          }),
        ],
      },
      {
        match: 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE',
        rows: [
          namedRow({
            COLUMN_NAME: 'SingerId',
            CONSTRAINT_NAME: 'PK_Singers',
            ORDINAL_POSITION: 1,
            POSITION_IN_UNIQUE_CONSTRAINT: null,
          }),
        ],
      },
      {
        match: 'INFORMATION_SCHEMA.TABLES',
        rows: [
          namedRow({
            TABLE_SCHEMA: '',
            TABLE_NAME: 'Singers',
            TABLE_TYPE: 'BASE TABLE',
            PARENT_TABLE_NAME: null,
            ON_DELETE_ACTION: null,
            SPANNER_STATE: 'COMMITTED',
            INTERLEAVE_TYPE: null,
            ROW_DELETION_POLICY_EXPRESSION: null,
          }),
        ],
      },
    ];
  });

  it('reads all three statements through one snapshot', async () => {
    await runTool(toolset(), 'spanner_get_table_schema', SCHEMA_ARGS);

    expect(spannerFake.queries).toHaveLength(3);
    expect(spannerFake.endedSnapshots).toBe(1);
    for (const query of spannerFake.queries) {
      expect(query.params).toEqual({table_name: 'Singers', named_schema: ''});
    }
  });

  it('reports the column schema, key constraints and table metadata', async () => {
    const result = await runTool(
      toolset(),
      'spanner_get_table_schema',
      SCHEMA_ARGS,
    );

    expect(successOf(result)['results']).toEqual({
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
              CONSTRAINT_NAME: 'PK_Singers',
              ORDINAL_POSITION: 1,
              POSITION_IN_UNIQUE_CONSTRAINT: null,
            },
          ],
        },
        Name: {
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
          TABLE_NAME: 'Singers',
          TABLE_TYPE: 'BASE TABLE',
          PARENT_TABLE_NAME: null,
          ON_DELETE_ACTION: null,
          SPANNER_STATE: 'COMMITTED',
          INTERLEAVE_TYPE: null,
          ROW_DELETION_POLICY_EXPRESSION: null,
        },
      ],
    });
  });

  it('collects two constraints on one column', async () => {
    spannerFake.responses[1] = {
      match: 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE',
      rows: [
        namedRow({
          COLUMN_NAME: 'SingerId',
          CONSTRAINT_NAME: 'PK_Singers',
          ORDINAL_POSITION: 1,
          POSITION_IN_UNIQUE_CONSTRAINT: null,
        }),
        namedRow({
          COLUMN_NAME: 'SingerId',
          CONSTRAINT_NAME: 'FK_Singers',
          ORDINAL_POSITION: 1,
          POSITION_IN_UNIQUE_CONSTRAINT: 2,
        }),
      ],
    };

    const result = await runTool(
      toolset(),
      'spanner_get_table_schema',
      SCHEMA_ARGS,
    );
    const results = successOf(result)['results'];

    expect(results).toMatchObject({
      schema: {SingerId: {KEY_COLUMN_USAGE: [{}, {}]}},
    });
  });

  it('drops a key column the column query did not return', async () => {
    spannerFake.responses[1] = {
      match: 'INFORMATION_SCHEMA.KEY_COLUMN_USAGE',
      rows: [
        namedRow({
          COLUMN_NAME: 'Dropped',
          CONSTRAINT_NAME: 'PK_Old',
          ORDINAL_POSITION: 1,
          POSITION_IN_UNIQUE_CONSTRAINT: null,
        }),
      ],
    };

    const result = await runTool(
      toolset(),
      'spanner_get_table_schema',
      SCHEMA_ARGS,
    );
    const results = successOf(result)['results'];

    expect(results).toMatchObject({schema: {SingerId: {}, Name: {}}});
    expect(JSON.stringify(results)).not.toContain('Dropped');
  });

  it('reads a named schema when the model asks for one', async () => {
    await runTool(toolset(), 'spanner_get_table_schema', {
      ...SCHEMA_ARGS,
      named_schema: 'sales',
    });

    expect(spannerFake.lastQuery().params).toEqual({
      table_name: 'Singers',
      named_schema: 'sales',
    });
  });

  it('renders a schema JSON cannot serialize', async () => {
    spannerFake.responses[0] = {
      match: 'INFORMATION_SCHEMA.COLUMNS',
      rows: [
        namedRow({
          COLUMN_NAME: 'SingerId',
          TABLE_SCHEMA: '',
          SPANNER_TYPE: 'INT64',
          ORDINAL_POSITION: 1n,
          COLUMN_DEFAULT: null,
          IS_NULLABLE: 'NO',
          IS_GENERATED: 'NEVER',
          GENERATION_EXPRESSION: null,
          IS_STORED: null,
        }),
      ],
    };

    const result = await runTool(
      toolset(),
      'spanner_get_table_schema',
      SCHEMA_ARGS,
    );

    expect(successOf(result)['results']).toEqual(
      expect.stringContaining('ORDINAL_POSITION: 1n'),
    );
  });

  it('refuses a PostgreSQL database, without a trailing period', async () => {
    spannerFake.dialect = 'POSTGRESQL';

    const result = await runTool(
      toolset(),
      'spanner_get_table_schema',
      SCHEMA_ARGS,
    );

    expect(errorOf(result)).toBe('PostgreSQL dialect is not supported');
  });

  it('reports a rejected read as an error', async () => {
    spannerFake.failures.run = new Error('table not found');

    const result = await runTool(
      toolset(),
      'spanner_get_table_schema',
      SCHEMA_ARGS,
    );

    expect(errorOf(result)).toBe('table not found');
  });
});

describe('a metadata tool whose end user has not authorized yet', () => {
  beforeEach(() => {
    spannerFake.reset();
  });

  it('asks the user to finish the authorization flow', async () => {
    const pending = new SpannerToolset({
      credentialsConfig: {clientId: 'id', clientSecret: 'secret'},
    });

    const result = await runTool(
      pending,
      'spanner_list_table_names',
      DATABASE_ARGS,
    );

    expect(errorOf(result)).toBe(
      'User authorization is required to access Google services for' +
        ' spanner_list_table_names. Please complete the authorization flow.',
    );
    expect(spannerFake.clientOptions).toHaveLength(0);
  });
});
