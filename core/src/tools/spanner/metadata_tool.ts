/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Database} from '@google-cloud/spanner';
import {z} from 'zod';
import {
  databaseParameters,
  databaseTarget,
  rejectPostgresql,
  withSpannerDatabase,
} from './client.js';
import {SpannerRow, rowValues, toSerializable} from './result_rows.js';
import {
  SpannerTool,
  SpannerToolFactoryOptions,
  SpannerToolStatus,
} from './spanner_tool.js';

/**
 * `INFORMATION_SCHEMA` records a database's unnamed schema as the empty
 * string; `_default` is the alias adk-python's Spanner client accepts for it.
 */
const DEFAULT_SCHEMA_ALIAS = '_default';

const namedSchemaParameter = z
  .string()
  .default('')
  .describe(
    "The named schema to search. Defaults to the database's default schema.",
  );

/** Maps a requested schema name onto its `INFORMATION_SCHEMA` value. */
function informationSchemaName(namedSchema: string): string {
  return namedSchema === DEFAULT_SCHEMA_ALIAS ? '' : namedSchema;
}

const listTableNamesParameters = z.object({
  ...databaseParameters,
  named_schema: namedSchemaParameter,
});

/**
 * Builds the tool that lists the tables of a Spanner database.
 *
 * `@google-cloud/spanner` has no table listing call, so this queries
 * `INFORMATION_SCHEMA.TABLES` directly.
 */
export function createListTableNamesTool(
  options: SpannerToolFactoryOptions,
): SpannerTool {
  return SpannerTool.create({
    ...options,
    name: 'list_table_names',
    description: 'List the tables within a Spanner database.',
    parameters: listTableNamesParameters,
    execute: ({args, credentials}) =>
      withSpannerDatabase(databaseTarget(args, credentials), async (db) => {
        const [rows] = await db.run({
          sql:
            'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ' +
            'WHERE TABLE_SCHEMA = @named_schema',
          params: {named_schema: informationSchemaName(args.named_schema)},
          types: {named_schema: 'string'},
        });
        return {
          status: SpannerToolStatus.SUCCESS,
          results: rows.map((row) => rowValues(row)[0]),
        };
      }),
  });
}

const COLUMNS_QUERY = `
    SELECT
        COLUMN_NAME,
        TABLE_SCHEMA,
        SPANNER_TYPE,
        ORDINAL_POSITION,
        COLUMN_DEFAULT,
        IS_NULLABLE,
        IS_GENERATED,
        GENERATION_EXPRESSION,
        IS_STORED
    FROM
        INFORMATION_SCHEMA.COLUMNS
    WHERE
        TABLE_NAME = @table_name
        AND TABLE_SCHEMA = @named_schema
    ORDER BY
        ORDINAL_POSITION
`;

const KEY_COLUMN_USAGE_QUERY = `
    SELECT
        COLUMN_NAME,
        CONSTRAINT_NAME,
        ORDINAL_POSITION,
        POSITION_IN_UNIQUE_CONSTRAINT
    FROM
        INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE
        TABLE_NAME = @table_name
        AND TABLE_SCHEMA = @named_schema
`;

const TABLE_METADATA_QUERY = `
    SELECT
        TABLE_SCHEMA,
        TABLE_NAME,
        TABLE_TYPE,
        PARENT_TABLE_NAME,
        ON_DELETE_ACTION,
        SPANNER_STATE,
        INTERLEAVE_TYPE,
        ROW_DELETION_POLICY_EXPRESSION
    FROM
        INFORMATION_SCHEMA.TABLES
    WHERE
        TABLE_NAME = @table_name
        AND TABLE_SCHEMA = @named_schema
`;

const COLUMN_KEYS = [
  'COLUMN_NAME',
  'TABLE_SCHEMA',
  'SPANNER_TYPE',
  'ORDINAL_POSITION',
  'COLUMN_DEFAULT',
  'IS_NULLABLE',
  'IS_GENERATED',
  'GENERATION_EXPRESSION',
  'IS_STORED',
];

const TABLE_METADATA_KEYS = [
  'TABLE_SCHEMA',
  'TABLE_NAME',
  'TABLE_TYPE',
  'PARENT_TABLE_NAME',
  'ON_DELETE_ACTION',
  'SPANNER_STATE',
  'INTERLEAVE_TYPE',
  'ROW_DELETION_POLICY_EXPRESSION',
];

const getTableSchemaParameters = z.object({
  ...databaseParameters,
  table_name: z.string().describe('The Spanner table name.'),
  named_schema: namedSchemaParameter,
});

/** The schema and metadata of one table, keyed as the model receives it. */
interface TableSchemaResults {
  schema: Record<string, Record<string, unknown>>;
  metadata: Array<Record<string, unknown>>;
}

/** Labels a row's values with the given column keys. */
function labelRow(row: SpannerRow, keys: string[]): Record<string, unknown> {
  const values = rowValues(row);
  return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
}

/** Runs one of the table-schema queries. */
async function runTableQuery(
  database: Database,
  sql: string,
  params: {table_name: string; named_schema: string},
) {
  const [rows] = await database.run({
    sql,
    params,
    types: {table_name: 'string', named_schema: 'string'},
  });
  return rows;
}

/** Builds the tool that describes the schema of one Spanner table. */
export function createGetTableSchemaTool(
  options: SpannerToolFactoryOptions,
): SpannerTool {
  return SpannerTool.create({
    ...options,
    name: 'get_table_schema',
    description:
      'Get the schema and metadata information about a Spanner table.',
    parameters: getTableSchemaParameters,
    execute: ({args, credentials}) =>
      withSpannerDatabase(databaseTarget(args, credentials), async (db) => {
        const rejection = await rejectPostgresql(db);
        if (rejection) {
          return rejection;
        }
        const params = {
          table_name: args.table_name,
          named_schema: args.named_schema,
        };
        const results: TableSchemaResults = {schema: {}, metadata: []};

        for (const row of await runTableQuery(db, COLUMNS_QUERY, params)) {
          const {COLUMN_NAME: name, ...column} = labelRow(row, COLUMN_KEYS);
          results.schema[String(name)] = column;
        }

        for (const row of await runTableQuery(
          db,
          KEY_COLUMN_USAGE_QUERY,
          params,
        )) {
          const [columnName, ...usage] = rowValues(row);
          const column = results.schema[String(columnName)];
          if (!column) {
            continue;
          }
          const keyUsage = (column['KEY_COLUMN_USAGE'] ??= []) as unknown[];
          keyUsage.push({
            CONSTRAINT_NAME: usage[0],
            ORDINAL_POSITION: usage[1],
            POSITION_IN_UNIQUE_CONSTRAINT: usage[2],
          });
        }

        for (const row of await runTableQuery(
          db,
          TABLE_METADATA_QUERY,
          params,
        )) {
          results.metadata.push(labelRow(row, TABLE_METADATA_KEYS));
        }

        return {
          status: SpannerToolStatus.SUCCESS,
          results: toSerializable(results),
        };
      }),
  });
}

const tableIndexParameters = z.object({
  ...databaseParameters,
  table_id: z.string().describe('The Spanner table id.'),
});

/**
 * Builds a tool that runs one `INFORMATION_SCHEMA` query about a table's
 * indexes and labels each row with the given keys.
 *
 * `list_table_indexes` and `list_table_index_columns` differ only in their
 * query and in the keys they label the columns with.
 */
function createIndexQueryTool(
  options: SpannerToolFactoryOptions,
  tool: {name: string; description: string; sql: string; keys: string[]},
): SpannerTool {
  return SpannerTool.create({
    ...options,
    name: tool.name,
    description: tool.description,
    parameters: tableIndexParameters,
    execute: ({args, credentials}) =>
      withSpannerDatabase(databaseTarget(args, credentials), async (db) => {
        const rejection = await rejectPostgresql(db);
        if (rejection) {
          return rejection;
        }
        const [rows] = await db.run({
          sql: tool.sql,
          params: {table_id: args.table_id},
          types: {table_id: 'string'},
        });
        return {
          status: SpannerToolStatus.SUCCESS,
          results: rows.map((row) => toSerializable(labelRow(row, tool.keys))),
        };
      }),
  });
}

/** Builds the tool that lists a table's indexes. */
export function createListTableIndexesTool(
  options: SpannerToolFactoryOptions,
): SpannerTool {
  return createIndexQueryTool(options, {
    name: 'list_table_indexes',
    description: 'List the indexes of a Spanner table.',
    sql:
      'SELECT INDEX_NAME, TABLE_SCHEMA, INDEX_TYPE,' +
      ' PARENT_TABLE_NAME, IS_UNIQUE, IS_NULL_FILTERED, INDEX_STATE ' +
      'FROM INFORMATION_SCHEMA.INDEXES ' +
      'WHERE TABLE_NAME = @table_id ',
    keys: [
      'INDEX_NAME',
      'TABLE_SCHEMA',
      'INDEX_TYPE',
      'PARENT_TABLE_NAME',
      'IS_UNIQUE',
      'IS_NULL_FILTERED',
      'INDEX_STATE',
    ],
  });
}

/** Builds the tool that lists the columns in each index of a table. */
export function createListTableIndexColumnsTool(
  options: SpannerToolFactoryOptions,
): SpannerTool {
  return createIndexQueryTool(options, {
    name: 'list_table_index_columns',
    description: 'List the columns in each index of a Spanner table.',
    sql:
      'SELECT INDEX_NAME, TABLE_SCHEMA, COLUMN_NAME,' +
      ' ORDINAL_POSITION, IS_NULLABLE, SPANNER_TYPE ' +
      'FROM INFORMATION_SCHEMA.INDEX_COLUMNS ' +
      'WHERE TABLE_NAME = @table_id ',
    keys: [
      'INDEX_NAME',
      'TABLE_SCHEMA',
      'COLUMN_NAME',
      'ORDINAL_POSITION',
      'IS_NULLABLE',
      'SPANNER_TYPE',
    ],
  });
}

const listNamedSchemasParameters = z.object({...databaseParameters});

const NAMED_SCHEMAS_QUERY = `
    SELECT
        SCHEMA_NAME
    FROM
        INFORMATION_SCHEMA.SCHEMATA
    WHERE
        SCHEMA_NAME NOT IN ('', 'INFORMATION_SCHEMA', 'SPANNER_SYS')
`;

/** Builds the tool that lists the named schemas of a Spanner database. */
export function createListNamedSchemasTool(
  options: SpannerToolFactoryOptions,
): SpannerTool {
  return SpannerTool.create({
    ...options,
    name: 'list_named_schemas',
    description: 'List the named schemas in a Spanner database.',
    parameters: listNamedSchemasParameters,
    execute: ({args, credentials}) =>
      withSpannerDatabase(databaseTarget(args, credentials), async (db) => {
        const rejection = await rejectPostgresql(db);
        if (rejection) {
          return rejection;
        }
        const [rows] = await db.run({sql: NAMED_SCHEMAS_QUERY});
        return {
          status: SpannerToolStatus.SUCCESS,
          results: rows.map((row) => rowValues(row)[0]),
        };
      }),
  });
}

/** Every metadata tool, in the order the toolset exposes them. */
export const METADATA_TOOL_FACTORIES = [
  createListTableNamesTool,
  createListTableIndexesTool,
  createListTableIndexColumnsTool,
  createListNamedSchemasTool,
  createGetTableSchemaTool,
];
