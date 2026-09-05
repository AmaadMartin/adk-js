/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bigtable, Instance, SqlTypes} from '@google-cloud/bigtable';

import {GoogleToolStatus} from '../google_tool.js';

import {isNamedValues, namedValuesToJson, type JsonValue} from './sql_value.js';

/** How the SDK spells the query options, which it does not export by name. */
type ExecuteQueryStreamOptions = Parameters<
  Instance['createExecuteQueryStream']
>[0];

/** The values the SDK accepts for a GoogleSQL query parameter. */
export type BigtableQueryParameters = NonNullable<
  ExecuteQueryStreamOptions['parameters']
>;

/** One value of {@link BigtableQueryParameters}. */
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
 * The SDK's own type descriptors, written as literals so that this module
 * stays type-only against `@google-cloud/bigtable` and never pulls it into
 * the import graph. The `SqlTypes.Type` annotation still checks every literal
 * against the SDK union, so a renamed tag fails the build.
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

/** What {@link executeSql} returns when the query succeeds. */
export interface ExecuteSqlResult {
  status: GoogleToolStatus.SUCCESS;
  rows: Array<{[key: string]: JsonValue}>;
  /**
   * Present, and always `true`, only when the row cap stopped the read before
   * the query ran out of rows.
   */
  resultIsLikelyTruncated?: true;
}

/** Options for {@link executeSql}. */
export interface ExecuteSqlOptions {
  /** The instance the query runs against. */
  instanceId: string;
  /** The GoogleSQL query to run. */
  query: string;
  /** Values for the `@name` placeholders in the query. */
  parameters?: BigtableQueryParameters;
  /** The declared GoogleSQL type of each `@name` placeholder. */
  parameterTypes?: Record<string, BigtableSqlParameterType>;
  /** How many rows to return before reporting the result as truncated. */
  maxRows: number;
}

/** Translates the model's type names into the SDK's type descriptors. */
function toSqlTypes(
  parameterTypes: Record<string, BigtableSqlParameterType> | undefined,
): Record<string, SqlTypes.Type> {
  const types: Record<string, SqlTypes.Type> = {};
  for (const [name, type] of Object.entries(parameterTypes ?? {})) {
    types[name] = SQL_PARAMETER_TYPES[type];
  }
  return types;
}

/**
 * Runs a GoogleSQL query against a Bigtable instance.
 *
 * The rows are read from a stream and the read stops at
 * {@link ExecuteSqlOptions.maxRows}, so a query matching far more rows than
 * the cap never buffers them all.
 *
 * @param client The Bigtable client to run the query with.
 * @param options The instance, the query, its parameters and the row cap.
 * @return The rows, flagged as truncated when the cap stopped the read.
 */
export async function executeSql(
  client: Bigtable,
  options: ExecuteSqlOptions,
): Promise<ExecuteSqlResult> {
  const instance = client.instance(options.instanceId);
  const [preparedStatement] = await instance.prepareStatement({
    query: options.query,
    parameterTypes: toSqlTypes(options.parameterTypes),
  });

  const stream = instance.createExecuteQueryStream({
    preparedStatement,
    parameters: options.parameters,
  });

  const rows: Array<{[key: string]: JsonValue}> = [];
  let truncated = false;
  try {
    for await (const row of stream) {
      if (rows.length >= options.maxRows) {
        truncated = true;
        break;
      }
      if (isNamedValues(row)) {
        rows.push(namedValuesToJson(row));
      }
    }
  } finally {
    stream.end();
  }

  const result: ExecuteSqlResult = {status: GoogleToolStatus.SUCCESS, rows};
  if (truncated) {
    result.resultIsLikelyTruncated = true;
  }
  return result;
}
