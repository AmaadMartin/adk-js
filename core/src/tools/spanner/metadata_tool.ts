/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {withSnapshot} from './client.js';
import {selectValueRows, toJsonSafe} from './result_rows.js';
import {POSTGRESQL_DIALECT, SpannerToolDefinition} from './spanner_tool.js';

const projectIdField = z
  .string()
  .describe('The GCP project id in which the Spanner database resides.');
const instanceIdField = z.string().describe('The Spanner instance id.');
const databaseIdField = z.string().describe('The Spanner database id.');
const namedSchemaField = z
  .string()
  .default('')
  .describe(
    'The named schema to search in. Defaults to the empty string, which is' +
      " the database's default schema.",
  );

/** What every metadata tool takes: which database to read. */
const databaseParams = z.object({
  project_id: projectIdField,
  instance_id: instanceIdField,
  database_id: databaseIdField,
});

const listTableNamesParams = databaseParams.extend({
  named_schema: namedSchemaField,
});

const getTableSchemaParams = databaseParams.extend({
  table_name: z.string().describe('The Spanner table name.'),
  named_schema: namedSchemaField,
});

const tableParams = databaseParams.extend({
  table_id: z.string().describe('The Spanner table id.'),
});

/** Reads the database and instance a metadata tool call names. */
function databaseTarget(args: z.infer<typeof databaseParams>) {
  return {
    projectId: args.project_id,
    instanceId: args.instance_id,
    databaseId: args.database_id,
  };
}

/**
 * Refuses a PostgreSQL database.
 *
 * Only `spanner_list_table_names` and the two search tools work against a
 * PostgreSQL dialect database; everything else queries `INFORMATION_SCHEMA`
 * with GoogleSQL syntax. adk-python writes this message without a trailing
 * period in `get_table_schema` alone, and the callers reproduce that.
 *
 * @param dialect The dialect the database reported.
 * @param message The message to report.
 * @throws Error if the database speaks PostgreSQL.
 */
function rejectPostgresql(dialect: string | undefined, message: string): void {
  if (dialect === POSTGRESQL_DIALECT) {
    throw new Error(message);
  }
}

const UNSUPPORTED_DIALECT = 'PostgreSQL dialect is not supported.';

const LIST_TABLES_QUERY = 'SELECT TABLE_NAME\nFROM INFORMATION_SCHEMA.TABLES\n';

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
          AND TABLE_SCHEMA = @named_schema;
  `;

const INDEXES_QUERY =
  'SELECT INDEX_NAME, TABLE_SCHEMA, INDEX_TYPE,' +
  ' PARENT_TABLE_NAME, IS_UNIQUE, IS_NULL_FILTERED, INDEX_STATE ' +
  'FROM INFORMATION_SCHEMA.INDEXES ' +
  'WHERE TABLE_NAME = @table_id ';

const INDEX_COLUMNS_QUERY =
  'SELECT INDEX_NAME, TABLE_SCHEMA, COLUMN_NAME,' +
  ' ORDINAL_POSITION, IS_NULLABLE, SPANNER_TYPE ' +
  'FROM INFORMATION_SCHEMA.INDEX_COLUMNS ' +
  'WHERE TABLE_NAME = @table_id ';

const NAMED_SCHEMAS_QUERY = `
    SELECT
        SCHEMA_NAME
    FROM
        INFORMATION_SCHEMA.SCHEMATA
    WHERE
        SCHEMA_NAME NOT IN ('', 'INFORMATION_SCHEMA', 'SPANNER_SYS');
    `;

/** Keys of one `INFORMATION_SCHEMA.INDEXES` row, in the order selected. */
const INDEX_FIELDS = [
  'INDEX_NAME',
  'TABLE_SCHEMA',
  'INDEX_TYPE',
  'PARENT_TABLE_NAME',
  'IS_UNIQUE',
  'IS_NULL_FILTERED',
  'INDEX_STATE',
] as const;

/** Keys of one `INFORMATION_SCHEMA.INDEX_COLUMNS` row, in the order selected. */
const INDEX_COLUMN_FIELDS = [
  'INDEX_NAME',
  'TABLE_SCHEMA',
  'COLUMN_NAME',
  'ORDINAL_POSITION',
  'IS_NULLABLE',
  'SPANNER_TYPE',
] as const;

/** Keys of one column's schema entry, after `COLUMN_NAME`. */
const COLUMN_FIELDS = [
  'TABLE_SCHEMA',
  'SPANNER_TYPE',
  'ORDINAL_POSITION',
  'COLUMN_DEFAULT',
  'IS_NULLABLE',
  'IS_GENERATED',
  'GENERATION_EXPRESSION',
  'IS_STORED',
] as const;

/** Keys of one key column's entry, after `COLUMN_NAME`. */
const KEY_COLUMN_FIELDS = [
  'CONSTRAINT_NAME',
  'ORDINAL_POSITION',
  'POSITION_IN_UNIQUE_CONSTRAINT',
] as const;

/** Keys of one `INFORMATION_SCHEMA.TABLES` row, in the order selected. */
const TABLE_METADATA_FIELDS = [
  'TABLE_SCHEMA',
  'TABLE_NAME',
  'TABLE_TYPE',
  'PARENT_TABLE_NAME',
  'ON_DELETE_ACTION',
  'SPANNER_STATE',
  'INTERLEAVE_TYPE',
  'ROW_DELETION_POLICY_EXPRESSION',
] as const;

/** Labels the values of one row with the field names selected for it. */
function labelRow(
  fields: readonly string[],
  values: readonly unknown[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field, index) => [field, values[index]]),
  );
}

/** One column's schema entry, with its key constraints once they are read. */
interface ColumnSchema extends Record<string, unknown> {
  KEY_COLUMN_USAGE?: Array<Record<string, unknown>>;
}

export const listTableNamesTool: SpannerToolDefinition<
  typeof listTableNamesParams
> = {
  name: 'list_table_names',
  description: 'List the tables within a Spanner database.',
  parameters: listTableNamesParams,
  target: databaseTarget,
  async run({database, dialect}, args) {
    const postgres = dialect === POSTGRESQL_DIALECT;
    // adk-python asks the client for the `_default` schema, which the client
    // resolves to the database's own default before it builds the statement.
    const named = args.named_schema;
    const schema =
      named && named !== '_default' ? named : postgres ? 'public' : '';
    const query = postgres
      ? {
          sql: `${LIST_TABLES_QUERY}WHERE TABLE_SCHEMA = $1\n`,
          params: {p1: schema},
          types: {p1: 'string'},
        }
      : {
          sql:
            `${LIST_TABLES_QUERY}WHERE TABLE_SCHEMA = @schema` +
            " AND SPANNER_STATE = 'COMMITTED'\n",
          params: {schema},
          types: {schema: 'string'},
        };
    const rows = await withSnapshot(database, (snapshot) =>
      selectValueRows(snapshot, query),
    );
    return {results: rows.map(([tableName]) => tableName)};
  },
};

export const getTableSchemaTool: SpannerToolDefinition<
  typeof getTableSchemaParams
> = {
  name: 'get_table_schema',
  description:
    'Get the column schema and table metadata of a Spanner table, including' +
    ' the primary key and other key constraints on each column.',
  parameters: getTableSchemaParams,
  target: databaseTarget,
  async run({database, dialect}, args) {
    // adk-python omits the trailing period here, and only here.
    rejectPostgresql(dialect, 'PostgreSQL dialect is not supported');
    const params = {
      table_name: args.table_name,
      named_schema: args.named_schema,
    };
    const types = {table_name: 'string', named_schema: 'string'};
    const schema: Record<string, ColumnSchema> = {};
    const metadata: Array<Record<string, unknown>> = [];

    // One snapshot, so the three statements see one consistent schema.
    await withSnapshot(database, async (snapshot) => {
      const columns = await selectValueRows(snapshot, {
        sql: COLUMNS_QUERY,
        params,
        types,
      });
      for (const [columnName, ...values] of columns) {
        schema[String(columnName)] = labelRow(COLUMN_FIELDS, values);
      }

      const keyColumns = await selectValueRows(snapshot, {
        sql: KEY_COLUMN_USAGE_QUERY,
        params,
        types,
      });
      for (const [columnName, ...values] of keyColumns) {
        const column = schema[String(columnName)];
        // A key column the column query did not return is dropped, as it is
        // in adk-python.
        if (column) {
          column.KEY_COLUMN_USAGE ??= [];
          column.KEY_COLUMN_USAGE.push(labelRow(KEY_COLUMN_FIELDS, values));
        }
      }

      const tables = await selectValueRows(snapshot, {
        sql: TABLE_METADATA_QUERY,
        params,
        types,
      });
      for (const values of tables) {
        metadata.push(labelRow(TABLE_METADATA_FIELDS, values));
      }
    });

    return {results: toJsonSafe({schema, metadata})};
  },
};

export const listTableIndexesTool: SpannerToolDefinition<typeof tableParams> = {
  name: 'list_table_indexes',
  description: 'List the indexes of a Spanner table.',
  parameters: tableParams,
  target: databaseTarget,
  async run({database, dialect}, args) {
    rejectPostgresql(dialect, UNSUPPORTED_DIALECT);
    const rows = await withSnapshot(database, (snapshot) =>
      selectValueRows(snapshot, {
        sql: INDEXES_QUERY,
        params: {table_id: args.table_id},
        types: {table_id: 'string'},
      }),
    );
    return {
      results: rows.map((values) => toJsonSafe(labelRow(INDEX_FIELDS, values))),
    };
  },
};

export const listTableIndexColumnsTool: SpannerToolDefinition<
  typeof tableParams
> = {
  name: 'list_table_index_columns',
  description: 'List the columns in each index of a Spanner table.',
  parameters: tableParams,
  target: databaseTarget,
  async run({database, dialect}, args) {
    rejectPostgresql(dialect, UNSUPPORTED_DIALECT);
    const rows = await withSnapshot(database, (snapshot) =>
      selectValueRows(snapshot, {
        sql: INDEX_COLUMNS_QUERY,
        params: {table_id: args.table_id},
        types: {table_id: 'string'},
      }),
    );
    return {
      results: rows.map((values) =>
        toJsonSafe(labelRow(INDEX_COLUMN_FIELDS, values)),
      ),
    };
  },
};

export const listNamedSchemasTool: SpannerToolDefinition<
  typeof databaseParams
> = {
  name: 'list_named_schemas',
  description: 'List the named schemas in a Spanner database.',
  parameters: databaseParams,
  target: databaseTarget,
  async run({database, dialect}) {
    rejectPostgresql(dialect, UNSUPPORTED_DIALECT);
    const rows = await withSnapshot(database, (snapshot) =>
      selectValueRows(snapshot, {sql: NAMED_SCHEMAS_QUERY}),
    );
    return {results: rows.map(([schemaName]) => schemaName)};
  },
};
