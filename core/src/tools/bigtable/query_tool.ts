/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Instance, SqlTypes} from '@google-cloud/bigtable';
import {Buffer} from 'node:buffer';
import {z} from 'zod';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {logger} from '../../utils/logger.js';
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

/** The GoogleSQL scalar types a query parameter may be declared as. */
const SCALAR_TYPE_NAMES = [
  'bool',
  'bytes',
  'date',
  'float32',
  'float64',
  'int64',
  'string',
  'timestamp',
] as const;

type ScalarTypeName = (typeof SCALAR_TYPE_NAMES)[number];

/** Maps each declarable scalar type name onto the SDK's type descriptor. */
const SQL_PARAMETER_TYPES: Record<ScalarTypeName, SqlTypes.Type> = {
  bool: {type: 'bool'},
  bytes: {type: 'bytes'},
  date: {type: 'date'},
  float32: {type: 'float32'},
  float64: {type: 'float64'},
  int64: {type: 'int64'},
  string: {type: 'string'},
  timestamp: {type: 'timestamp'},
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
      'Values for the query parameters, keyed by the name used in the query.',
    ),
  parameter_types: z
    .record(z.string(), z.enum(SCALAR_TYPE_NAMES))
    .optional()
    .describe(
      'The GoogleSQL type of each query parameter, keyed by the name used in the query.',
    ),
});

type QueryArguments = z.infer<typeof querySchema>;

/** The shape the SDK gives a query result row and a `STRUCT` value. */
interface NamedValues {
  values: unknown[];
  fieldMapping: {fieldNames: Array<string | null>};
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
  if (value instanceof Map) {
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

/**
 * Reads up to `maxRows` rows from a query, stopping the read at the cap.
 *
 * @param instance The Bigtable instance the query runs against.
 * @param args The validated query arguments.
 * @param parameters The parameter values, including any resolved view
 *     parameters.
 * @param maxRows The row cap.
 * @return The rows read, and whether the cap stopped the read.
 */
async function readRows(
  instance: Instance,
  args: QueryArguments,
  parameters: QueryParameters,
  maxRows: number,
): Promise<{rows: Array<Record<string, unknown>>; truncated: boolean}> {
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
 * View parameter names the invocation itself answers.
 *
 * The map is explicit so that a name is only ever answered by the property it
 * names. Reading the context by dynamic property name would let an agent widen
 * its own access by writing, say, `user_id` into session state.
 */
const CONTEXT_VIEW_PARAMETERS = new Map<
  string,
  (context: ReadonlyContext) => string
>([
  ['user_id', (context) => context.userId],
  ['userId', (context) => context.userId],
  ['session_id', (context) => context.sessionId],
  ['sessionId', (context) => context.sessionId],
  ['invocation_id', (context) => context.invocationId],
  ['invocationId', (context) => context.invocationId],
  ['agent_name', (context) => context.agentName],
  ['agentName', (context) => context.agentName],
]);

/** Returns whether a session state value may be sent as a query parameter. */
function isQueryParameterValue(
  value: unknown,
): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Resolves the trusted values a parameterized view filters on.
 *
 * A name the invocation answers wins; otherwise the value comes from session
 * state. A name that resolves nowhere is left out, so the query fails at
 * Bigtable rather than running unfiltered.
 *
 * @param names The view parameter names the toolset was configured with.
 * @param context The context of the tool call.
 * @return The resolved values, keyed by view parameter name.
 * @throws If there is no context, since the values cannot be trusted without
 *     one.
 */
export function resolveViewParameters(
  names: string[],
  context?: ReadonlyContext,
): QueryParameters {
  if (context === undefined) {
    throw new Error(
      'execute_sql_parameterized needs a tool context to resolve its view parameters.',
    );
  }
  const resolved: QueryParameters = {};
  for (const name of names) {
    const fromContext = CONTEXT_VIEW_PARAMETERS.get(name);
    if (fromContext !== undefined) {
      resolved[name] = fromContext(context);
      continue;
    }
    const fromState = context.state.get(name);
    if (fromState === undefined) {
      continue;
    }
    if (!isQueryParameterValue(fromState)) {
      logger.warn(
        `Skipping view parameter '${name}': session state holds a ` +
          `${typeof fromState}, which Bigtable does not accept as a query parameter.`,
      );
      continue;
    }
    resolved[name] = fromState;
  }
  return resolved;
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
  viewParameters: QueryParameters,
): Promise<{
  rows: Array<Record<string, unknown>>;
  result_is_likely_truncated?: true;
}> {
  const client = await clients.get(args.project_id);
  const instance = client.instance(args.instance_id);
  const {rows, truncated} = await readRows(
    instance,
    args,
    // The resolved view parameters go last, so a model-supplied parameter of
    // the same name cannot forge the value the view filters on.
    {...args.parameters, ...viewParameters},
    maxQueryResultRows(settings),
  );
  return truncated ? {rows, result_is_likely_truncated: true} : {rows};
}

/**
 * Builds the GoogleSQL query tool.
 *
 * @param clients The client cache the tool reads through.
 * @param settings The row cap configuration.
 * @return The tool, with adk-python's unprefixed name.
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
        executeQuery(clients, settings, args, {}),
      ),
  });
}

/**
 * Builds the query tool that scopes a parameterized view to the caller.
 *
 * The view parameter values come from the invocation, never from the model's
 * arguments, so a model cannot read another user's rows through a view
 * created as `SELECT * FROM purchases WHERE user_id = VIEW_PARAMETERS('user_id')`.
 *
 * @param clients The client cache the tool reads through.
 * @param viewParameterNames The names the tool resolves per call.
 * @param settings The row cap configuration.
 * @return The tool, with adk-python's unprefixed name.
 */
export function createParameterizedQueryTool(
  clients: BigtableClientCache,
  viewParameterNames: string[],
  settings?: BigtableToolSettings,
): BaseTool {
  return new FunctionTool({
    name: 'execute_sql_parameterized',
    description:
      'Execute a GoogleSQL query from a Bigtable table using parameterized views to securely check permissions.',
    parameters: querySchema,
    execute: (args, context) =>
      runBigtableTool('execute_sql_parameterized', () =>
        executeQuery(
          clients,
          settings,
          args,
          resolveViewParameters(viewParameterNames, context),
        ),
      ),
  });
}
