/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bigtable, Instance, SqlTypes} from '@google-cloud/bigtable';
import type {NamedList} from '@google-cloud/bigtable/build/src/execute-query/namedlist.js';
import type {SqlValue} from '@google-cloud/bigtable/build/src/execute-query/values.js';
import {z} from 'zod';

import {BigtableToolSettings} from './settings.js';
import {runBigtableTool} from './tool_result.js';

const DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS = 50;

/**
 * The values the Bigtable SDK accepts for a GoogleSQL query parameter.
 *
 * Read off `ExecuteQueryOptions`, which `@google-cloud/bigtable@6.5.1` does
 * not re-export from the package root.
 */
export type BigtableQueryParameters = NonNullable<
  Parameters<Instance['createExecuteQueryStream']>[0]['parameters']
>;

/** A single value of {@link BigtableQueryParameters}. */
export type BigtableQueryParameterValue = BigtableQueryParameters[string];

/** The GoogleSQL scalar types a query parameter can be declared as. */
export const SQL_PARAMETER_TYPE_NAMES = [
  'bool',
  'bytes',
  'date',
  'float32',
  'float64',
  'int64',
  'string',
  'timestamp',
] as const;

/** The name of a GoogleSQL scalar type, as the model spells it. */
export type BigtableSqlParameterType =
  (typeof SQL_PARAMETER_TYPE_NAMES)[number];

/**
 * The SDK's own type descriptors, written as literals rather than built with
 * the `SqlTypes.Bool()` factories so that this module stays type-only against
 * `@google-cloud/bigtable` (see the note in `client.ts`). The
 * `Record<..., SqlTypes.Type>` annotation still checks every literal against
 * the SDK union, so a renamed tag fails the build.
 */
const SQL_PARAMETER_TYPES: Record<BigtableSqlParameterType, SqlTypes.Type> = {
  bool: {type: 'bool'},
  bytes: {type: 'bytes'},
  date: {type: 'date'},
  float32: {type: 'float32'},
  float64: {type: 'float64'},
  int64: {type: 'int64'},
  string: {type: 'string'},
  timestamp: {type: 'timestamp'},
};

/** A value that survives `JSON.stringify` on its way to the model. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {[key: string]: JsonValue};

export const ExecuteSqlArgsSchema = z.object({
  projectId: z
    .string()
    .describe('The GCP project id in which the query should be executed.'),
  instanceId: z.string().describe('The instance id of the Bigtable database.'),
  query: z.string().describe('The Bigtable SQL query to be executed.'),
  parameters: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional()
    .describe(
      'Values for the query parameters. Keys must match the `@name` placeholders used in query.',
    ),
  parameterTypes: z
    .record(z.string(), z.enum(SQL_PARAMETER_TYPE_NAMES))
    .optional()
    .describe(
      'The GoogleSQL type of each parameter used in query, keyed by parameter name.',
    ),
});

/** Options for {@link executeSql}. */
export interface ExecuteSqlOptions {
  instanceId: string;
  query: string;
  /** Values for the `@name` placeholders in the query. */
  parameters?: BigtableQueryParameters;
  /** The declared GoogleSQL type of each parameter used in the query. */
  parameterTypes?: Record<string, BigtableSqlParameterType>;
  /**
   * Parameter values resolved from trusted session state rather than supplied
   * by the model. They take precedence over same-named `parameters`, so the
   * model cannot forge the values a parameterized view filters on.
   */
  viewParameters?: BigtableQueryParameters;
  settings?: BigtableToolSettings;
}

/**
 * Runs a GoogleSQL query against a Bigtable instance and returns the rows,
 * capped at {@link BigtableToolSettings.maxQueryResultRows}.
 */
export function executeSql(client: Bigtable, options: ExecuteSqlOptions) {
  return runBigtableTool('execute_sql', async () => {
    const instance = client.instance(options.instanceId);
    const [preparedStatement] = await instance.prepareStatement({
      query: options.query,
      parameterTypes: toSqlTypes(options.parameterTypes),
    });

    const stream: AsyncIterable<unknown> = instance.createExecuteQueryStream({
      preparedStatement,
      parameters: {...options.parameters, ...options.viewParameters},
    });

    const maxRows =
      options.settings?.maxQueryResultRows &&
      options.settings.maxQueryResultRows > 0
        ? options.settings.maxQueryResultRows
        : DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS;

    const rows: Array<{[key: string]: JsonValue}> = [];
    let resultIsLikelyTruncated = false;
    for await (const row of stream) {
      if (rows.length >= maxRows) {
        resultIsLikelyTruncated = true;
        break;
      }
      if (!isNamedList(row)) {
        throw new Error(
          'createExecuteQueryStream yielded a row that is not a QueryResultRow.',
        );
      }
      rows.push(namedListToJson(row));
    }

    return {rows, result_is_likely_truncated: resultIsLikelyTruncated};
  });
}

/** Resolves the SDK type descriptor for each declared parameter type. */
function toSqlTypes(
  parameterTypes?: Record<string, BigtableSqlParameterType>,
): Record<string, SqlTypes.Type> | undefined {
  if (!parameterTypes) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(parameterTypes).map(([name, type]) => [
      name,
      SQL_PARAMETER_TYPES[type],
    ]),
  );
}

/**
 * `QueryResultRow` and `Struct` both extend `NamedList`, which stores cells
 * positionally and resolves column names by index.
 */
function isNamedList(value: unknown): value is NamedList<SqlValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'values' in value &&
    'getFieldNameAtIndex' in value
  );
}

/** `EncodedKeyMap` implements `Map` rather than extending it. */
function isMapLike(value: object): value is Map<unknown, unknown> {
  return 'entries' in value && Symbol.iterator in value;
}

/** Reads a row or struct column-wise into a plain JSON object. */
function namedListToJson(list: NamedList<SqlValue>): {
  [key: string]: JsonValue;
} {
  const result: {[key: string]: JsonValue} = {};
  list.values.forEach((value, index) => {
    result[list.getFieldNameAtIndex(index) ?? String(index)] =
      toJsonValue(value);
  });
  return result;
}

/**
 * Converts a Bigtable cell to something `JSON.stringify` can carry to the
 * model: `INT64` arrives as a `bigint`, `BYTES` as a `Uint8Array` and `STRUCT`
 * as a positional `NamedList`, none of which serialize usefully on their own.
 */
function toJsonValue(value: unknown): JsonValue {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return null;
  }

  if (value === null) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isNamedList(value)) {
    return namedListToJson(value);
  }
  if (isMapLike(value)) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [
        String(key),
        toJsonValue(entry),
      ]),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
  );
}
