/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Instance, SqlTypes} from '@google-cloud/bigtable';
import {Buffer} from 'node:buffer';
import {z} from 'zod';

import {BaseTool} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';

import {BigtableClientCache} from './client.js';
import {BigtableToolSettings, maxQueryResultRows} from './settings.js';
import {runBigtableTool} from './tool_result.js';

/**
 * The parameter bag the SDK accepts for a query.
 *
 * Taken from the method that consumes it, because the SDK does not re-export
 * its query value types from the package entry point.
 */
type QueryParameters = NonNullable<
  Parameters<Instance['createExecuteQueryStream']>[0]['parameters']
>;

/** One value in that bag. */
type QueryParameterValue = QueryParameters[string];

/**
 * What a model can put in a query parameter, since it only emits JSON.
 *
 * A `null` never reaches a converter: {@link toQueryParameters} passes it
 * straight through.
 */
type JsonValue = string | number | boolean;

/**
 * The GoogleSQL types a query parameter may be declared as.
 *
 * GoogleSQL also has `date` and `timestamp`, which are left out: the SDK
 * accepts them only as its own `BigtableDate` and `PreciseDate` instances, and
 * neither class is reachable from the package entry point. Compare against a
 * literal in the query text instead.
 */
const SCALAR_TYPE_NAMES = [
  'bool',
  'bytes',
  'float32',
  'float64',
  'int64',
  'string',
] as const;

type ScalarTypeName = (typeof SCALAR_TYPE_NAMES)[number];

/** Maps each declarable type name onto the SDK's type descriptor. */
const SQL_PARAMETER_TYPES: Record<ScalarTypeName, SqlTypes.Type> = {
  bool: {type: 'bool'},
  bytes: {type: 'bytes'},
  float32: {type: 'float32'},
  float64: {type: 'float64'},
  int64: {type: 'int64'},
  string: {type: 'string'},
};

/**
 * The query tool arguments.
 *
 * The field names are `snake_case` because they cross the model boundary and
 * adk-python spells them that way. The parameter values are constrained to
 * JSON scalars: a model-facing schema is a trust boundary, so the tool decides
 * what shapes it accepts rather than forwarding whatever arrives.
 */
const querySchema = z.object({
  project_id: z
    .string()
    .describe('The Google Cloud project id the query runs in.'),
  instance_id: z.string().describe('The Bigtable instance id.'),
  query: z.string().describe('The Bigtable GoogleSQL query to execute.'),
  parameters: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional()
    .describe(
      'Values for the query parameters, keyed by the name used in the query. ' +
        'Every name here must also appear in parameter_types. Give an int64 ' +
        'as a decimal string or a whole number, and bytes as base64.',
    ),
  parameter_types: z
    .record(z.string(), z.enum(SCALAR_TYPE_NAMES))
    .optional()
    .describe(
      'The GoogleSQL type of each query parameter, keyed by the name used in ' +
        'the query. Required for every name in parameters.',
    ),
});

type QueryArguments = z.infer<typeof querySchema>;

/** The shape the SDK gives a query result row and a `STRUCT` value. */
interface NamedValues {
  values: unknown[];
  fieldMapping: {fieldNames: Array<string | null>};
}

/** The read side of the SDK's `MAP` value. */
interface MapValues {
  entries(): Iterable<[unknown, unknown]>;
  readonly size: number;
}

/**
 * Returns whether `value` carries named columns.
 *
 * Structural rather than an `instanceof` check, because the SDK class is
 * loaded lazily and a second copy of the package would fail identity.
 */
function isNamedValues(value: object): value is NamedValues {
  return (
    'values' in value &&
    Array.isArray(value.values) &&
    'fieldMapping' in value &&
    typeof value.fieldMapping === 'object' &&
    value.fieldMapping !== null &&
    'fieldNames' in value.fieldMapping
  );
}

/**
 * Returns whether `value` is a map.
 *
 * The SDK returns `EncodedKeyMap`, which implements `Map` without extending
 * it, so `value instanceof Map` is false for every map a query returns.
 */
function isMapValues(value: object): value is MapValues {
  return (
    'entries' in value && typeof value.entries === 'function' && 'size' in value
  );
}

/** Returns whether `value` is the SDK's year/month/day DATE representation. */
function isCalendarDate(
  value: object,
): value is {year: number; month: number; day: number} {
  return 'year' in value && 'month' in value && 'day' in value;
}

/** Pads a date component to the width GoogleSQL renders it at. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Converts one query result value into a JSON-serializable one.
 *
 * adk-python round-trips each cell through `json.dumps` and falls back to
 * `str(val)`; the same outcomes are produced here by converting each shape the
 * SDK can emit, and stringifying anything else.
 *
 * @param value The value the SDK decoded.
 * @return The JSON-serializable form.
 */
export function convertSqlValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(convertSqlValue);
  }
  if (isMapValues(value)) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [
        String(convertSqlValue(key)),
        convertSqlValue(entry),
      ]),
    );
  }
  if (isNamedValues(value)) {
    return namedValuesToRecord(value);
  }
  if (isCalendarDate(value)) {
    return `${pad(value.year, 4)}-${pad(value.month, 2)}-${pad(value.day, 2)}`;
  }
  return String(value);
}

/**
 * Converts named columns into a plain object.
 *
 * A column the result set did not name is dropped, because it has no key to
 * be read back by.
 *
 * @param named The row or struct to convert.
 * @return The column values keyed by column name.
 */
function namedValuesToRecord(named: NamedValues): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  named.fieldMapping.fieldNames.forEach((name, index) => {
    if (name !== null) {
      record[name] = convertSqlValue(named.values[index]);
    }
  });
  return record;
}

/** Reports a value the declared GoogleSQL type cannot be built from. */
function parameterError(
  name: string,
  type: ScalarTypeName,
  reason: string,
): Error {
  return new Error(
    `Query parameter '${name}' is not a valid ${type}: ${reason}`,
  );
}

/** Rejects a value whose JavaScript type the declared type cannot accept. */
function rejectParameter(
  name: string,
  type: ScalarTypeName,
  value: JsonValue,
): never {
  throw parameterError(name, type, `got a ${typeof value}`);
}

/** Builds the `bigint` the SDK requires for an INT64 parameter. */
function toInt64(name: string, value: JsonValue): bigint {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'number' || typeof value === 'string') {
    throw parameterError(name, 'int64', `${value} is not a whole number`);
  }
  return rejectParameter(name, 'int64', value);
}

/** Builds the byte array the SDK requires for a BYTES parameter. */
function toBytes(name: string, value: JsonValue): Uint8Array {
  if (typeof value !== 'string') {
    return rejectParameter(name, 'bytes', value);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw parameterError(name, 'bytes', 'expected canonical base64');
  }
  return decoded;
}

/** Builds the native value each declarable type needs from a JSON scalar. */
const PARAMETER_CONVERTERS: Record<
  ScalarTypeName,
  (name: string, value: JsonValue) => QueryParameterValue
> = {
  bool: (name, value) =>
    typeof value === 'boolean' ? value : rejectParameter(name, 'bool', value),
  bytes: toBytes,
  float32: (name, value) =>
    typeof value === 'number' ? value : rejectParameter(name, 'float32', value),
  float64: (name, value) =>
    typeof value === 'number' ? value : rejectParameter(name, 'float64', value),
  int64: toInt64,
  string: (name, value) =>
    typeof value === 'string' ? value : rejectParameter(name, 'string', value),
};

/**
 * Converts the model's parameters into the native values the SDK requires.
 *
 * The SDK builds each value from the type the prepared statement declared, and
 * rejects a JSON scalar where it wants a `bigint` or a byte array. It also
 * rejects the whole query when the two bags do not name the same parameters,
 * so both mismatches are reported here by name instead.
 *
 * @param args The validated query arguments.
 * @return The parameter bag to run the query with.
 * @throws If a parameter has no declared type, a declared type has no value,
 *     or a value cannot be converted to its declared type.
 */
export function toQueryParameters(args: QueryArguments): QueryParameters {
  const values = args.parameters ?? {};
  const types = args.parameter_types ?? {};
  const converted: QueryParameters = {};
  for (const [name, value] of Object.entries(values)) {
    const type = types[name];
    if (type === undefined) {
      throw new Error(
        `Query parameter '${name}' has no entry in parameter_types. Declare a type for every parameter.`,
      );
    }
    converted[name] =
      value === null ? null : PARAMETER_CONVERTERS[type](name, value);
  }
  for (const name of Object.keys(types)) {
    if (!(name in values)) {
      throw new Error(
        `Query parameter '${name}' is declared in parameter_types but has no value in parameters.`,
      );
    }
  }
  return converted;
}

/**
 * Reads up to `maxRows` rows from a query, stopping the read at the cap.
 *
 * @param instance The Bigtable instance the query runs against.
 * @param args The validated query arguments.
 * @param maxRows The row cap.
 * @return The rows read, and whether the cap stopped the read.
 */
async function readRows(
  instance: Instance,
  args: QueryArguments,
  maxRows: number,
): Promise<{rows: Array<Record<string, unknown>>; truncated: boolean}> {
  const parameters = toQueryParameters(args);
  const [preparedStatement] = await instance.prepareStatement({
    query: args.query,
    parameterTypes: toParameterTypes(args.parameter_types),
  });
  const stream = instance.createExecuteQueryStream({
    preparedStatement,
    parameters,
  });
  // The SDK's stream is a `Duplex`, whose iterator is untyped; it yields the
  // decoded rows.
  const rowStream: AsyncIterable<NamedValues> = stream;

  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;
  try {
    for await (const row of rowStream) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(namedValuesToRecord(row));
    }
  } finally {
    stream.destroy();
  }
  return {rows, truncated};
}

/** Converts the declared parameter types into the SDK's descriptors. */
function toParameterTypes(
  declared: Record<string, ScalarTypeName> | undefined,
): Record<string, SqlTypes.Type> | undefined {
  if (declared === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(declared).map(([name, type]) => [
      name,
      SQL_PARAMETER_TYPES[type],
    ]),
  );
}

/**
 * Runs a query and shapes the result the way adk-python's query tool does.
 *
 * `result_is_likely_truncated` is only present when the cap actually stopped
 * the read; adk-python never emits it as `false`.
 */
async function executeQuery(
  clients: BigtableClientCache,
  settings: BigtableToolSettings | undefined,
  args: QueryArguments,
): Promise<{
  rows: Array<Record<string, unknown>>;
  result_is_likely_truncated?: true;
}> {
  const client = await clients.get(args.project_id);
  const instance = client.instance(args.instance_id);
  const {rows, truncated} = await readRows(
    instance,
    args,
    maxQueryResultRows(settings),
  );
  return truncated ? {rows, result_is_likely_truncated: true} : {rows};
}

/**
 * Builds the GoogleSQL query tool.
 *
 * @param clients The client cache the tool reads through.
 * @param settings The row cap configuration.
 * @return The query tool.
 */
export function createQueryTool(
  clients: BigtableClientCache,
  settings?: BigtableToolSettings,
): BaseTool {
  return new FunctionTool({
    name: 'execute_sql',
    description: 'Execute a GoogleSQL query from a Bigtable table.',
    parameters: querySchema,
    execute: (args) =>
      runBigtableTool('execute_sql', () =>
        executeQuery(clients, settings, args),
      ),
  });
}
