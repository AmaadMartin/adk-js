/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `execute_sql` and the three BigQuery ML tools.
 *
 * Ported from adk-python `src/google/adk/integrations/bigquery/query_tool.py`
 * (branch `main`). Argument names stay `snake_case`: the model produces them,
 * so they cross the language boundary and must match adk-python.
 */

import type {BigQuery, JobMetadata, Query} from '@google-cloud/bigquery';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

import {Context} from '../../agents/context.js';
import {BaseTool} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';

import {BigQueryToolDeps, getToolClient} from './client.js';
import {ResolvedBigQueryToolConfig, WriteMode} from './config.js';
import {executeSqlDescription} from './query_tool_descriptions.js';
import {
  escapeSingleQuotes,
  invalidIdentifierMessage,
  isSubquery,
  isValidColumnIdentifier,
  isValidTableIdentifier,
  toIdentifierArrayLiteral,
} from './sql_utils.js';
import {
  BigQueryToolError,
  BigQueryToolResult,
  bigQueryToolError,
  runBigQueryTool,
} from './tool_result.js';

/** State key holding the BigQuery session a `PROTECTED` toolset opened. */
export const BIGQUERY_SESSION_INFO_KEY = 'bigquery_session_info';

/** The session id and the anonymous dataset id of a BigQuery session. */
export type BigQuerySessionInfo = [string, string];

/** A connection property of a BigQuery query job. */
type ConnectionProperty = NonNullable<Query['connectionProperties']>[number];

/** A row of a query result, as the model reads it. */
export type BigQueryRow = Record<string, unknown>;

/** A successful query, carrying its rows. */
export interface BigQueryRowsResult {
  status: 'SUCCESS';
  rows: BigQueryRow[];
  /** Set when more rows match the query than were returned. */
  result_is_likely_truncated?: boolean;
}

/** A successful dry run, carrying what BigQuery reported about the query. */
export interface BigQueryDryRunResult {
  status: 'SUCCESS';
  dry_run_info: JobMetadata;
}

/** What `execute_sql` and the BigQuery ML tools resolve to. */
export type ExecuteSqlResult = BigQueryToolResult<
  BigQueryRowsResult | BigQueryDryRunResult
>;

/** The default `forecast` horizon, in time steps. */
const DEFAULT_FORECAST_HORIZON = 10;

/** The default `detect_anomalies` horizon, in time steps. */
const DEFAULT_ANOMALY_HORIZON = 1000;

/** The default `detect_anomalies` anomaly probability threshold. */
const DEFAULT_ANOMALY_PROB_THRESHOLD = 0.95;

/** How many insights `analyze_contribution` returns by default. */
const DEFAULT_TOP_K_INSIGHTS = 30;

/** The `analyze_contribution` pruning methods BigQuery ML accepts. */
const PRUNING_METHODS = ['NO_PRUNING', 'PRUNE_REDUNDANT_INSIGHTS'];

/** The forecasting model `AI.FORECAST` runs. */
const FORECAST_MODEL = 'TimesFM 2.0';

/** The prediction interval `forecast` reports. */
const FORECAST_CONFIDENCE_LEVEL = 0.95;

/** Arguments of {@link executeSql}. */
export const EXECUTE_SQL_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the query should be executed.'),
  query: z.string().describe('The BigQuery SQL query to be executed.'),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      'If true, the query is validated and described instead of being run.',
    ),
});

/** Arguments of {@link forecast}. */
export const FORECAST_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the query should be executed.'),
  history_data: z
    .string()
    .describe(
      'The table id of the BigQuery table holding the history time series ' +
        'data, or a query statement that selects it.',
    ),
  timestamp_col: z
    .string()
    .describe('The name of the column holding the timestamp of a data point.'),
  data_col: z
    .string()
    .describe('The name of the column holding the values to forecast.'),
  horizon: z
    .number()
    .optional()
    .describe('How many time steps to forecast into the future.'),
  id_cols: z
    .array(z.string())
    .optional()
    .describe(
      'The id columns that separate the time series, when the data holds ' +
        'more than one.',
    ),
});

/** Arguments of {@link analyzeContribution}. */
export const ANALYZE_CONTRIBUTION_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the query should be executed.'),
  input_data: z
    .string()
    .describe(
      'The data holding the test and control rows: a fully qualified ' +
        'BigQuery table id, or a SQL query.',
    ),
  contribution_metric: z
    .string()
    .describe(
      'The expression of the metric to analyze, for example ' +
        '"SUM(sales)" or "SUM(clicks)/SUM(impressions)".',
    ),
  dimension_id_cols: z
    .array(z.string())
    .describe('The names of the dimension columns.'),
  is_test_col: z
    .string()
    .describe(
      'The name of the BOOL column that marks a row as test or control data.',
    ),
  top_k_insights: z
    .number()
    .optional()
    .describe('How many top insights to return, ranked by apriori support.'),
  pruning_method: z
    .string()
    .optional()
    .describe(
      'How to prune redundant insights: "NO_PRUNING" or ' +
        '"PRUNE_REDUNDANT_INSIGHTS".',
    ),
});

/** Arguments of {@link detectAnomalies}. */
export const DETECT_ANOMALIES_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the query should be executed.'),
  history_data: z
    .string()
    .describe(
      'The table id of the BigQuery table holding the history time series ' +
        'data, or a query statement that selects it.',
    ),
  times_series_timestamp_col: z
    .string()
    .describe('The name of the column holding the timestamp of a data point.'),
  times_series_data_col: z
    .string()
    .describe('The name of the column holding the values to model.'),
  horizon: z
    .number()
    .optional()
    .describe('How many time steps the model forecasts.'),
  target_data: z
    .string()
    .optional()
    .describe(
      'The data to detect anomalies in: a table id or a query statement. ' +
        'Absent means the history data itself.',
    ),
  times_series_id_cols: z
    .array(z.string())
    .optional()
    .describe(
      'The id columns that separate the time series, when the data holds ' +
        'more than one.',
    ),
  anomaly_prob_threshold: z
    .number()
    .optional()
    .describe('The probability above which a point counts as an anomaly.'),
});

/** Builds the labels one BigQuery job carries. */
function buildJobLabels(
  settings: ResolvedBigQueryToolConfig,
  callerId: string,
): Record<string, string> {
  const labels: Record<string, string> = {...settings.jobLabels};
  labels['adk-bigquery-tool'] = callerId;
  if (settings.applicationName) {
    labels['adk-bigquery-application-name'] = settings.applicationName;
  }
  return labels;
}

/** Runs a dry run of `query` and returns what BigQuery reported about it. */
async function dryRunQuery(
  client: BigQuery,
  query: string,
  labels: Record<string, string>,
  connectionProperties: ConnectionProperty[],
): Promise<JobMetadata> {
  const [, resource] = await client.createQueryJob({
    query,
    dryRun: true,
    labels,
    connectionProperties,
  });
  return resource;
}

/** The kind of statement BigQuery parsed a query as. */
function statementType(resource: JobMetadata): string | undefined {
  return resource.statistics?.query?.statementType ?? undefined;
}

/** The dataset a query would write its result to. */
function destinationDatasetId(resource: JobMetadata): string | undefined {
  return (
    resource.configuration?.query?.destinationTable?.datasetId ?? undefined
  );
}

/** Opens a BigQuery session and returns its id and anonymous dataset. */
async function openSession(
  client: BigQuery,
  labels: Record<string, string>,
): Promise<BigQuerySessionInfo> {
  const [, resource] = await client.createQueryJob({
    query: 'SELECT 1',
    dryRun: true,
    createSession: true,
    labels,
  });
  return [
    resource.statistics?.sessionInfo?.sessionId ?? '',
    destinationDatasetId(resource) ?? '',
  ];
}

/**
 * Returns the session a `PROTECTED` toolset works in, opening one on the
 * first call and remembering it in the tool context.
 */
async function resolveSession(
  client: BigQuery,
  labels: Record<string, string>,
  toolContext?: Context,
): Promise<BigQuerySessionInfo> {
  const remembered = toolContext?.state.get<BigQuerySessionInfo>(
    BIGQUERY_SESSION_INFO_KEY,
  );
  if (remembered) {
    return remembered;
  }
  const session = await openSession(client, labels);
  toolContext?.state.set(BIGQUERY_SESSION_INFO_KEY, session);
  return session;
}

/** What the write-mode gate decided about one query. */
interface WriteModeDecision {
  /** Set when the query is refused. */
  error?: BigQueryToolError;
  /** The connection properties the query must run with. */
  connectionProperties: ConnectionProperty[];
}

/** Applies the `BLOCKED` gate: only a `SELECT` statement runs. */
async function gateBlocked(
  client: BigQuery,
  query: string,
  labels: Record<string, string>,
): Promise<WriteModeDecision> {
  const resource = await dryRunQuery(client, query, labels, []);
  if (statementType(resource) !== 'SELECT') {
    return {
      error: bigQueryToolError(
        'Read-only mode only supports SELECT statements.',
      ),
      connectionProperties: [],
    };
  }
  return {connectionProperties: []};
}

/**
 * Applies the `PROTECTED` gate: a `SELECT` statement, or a write into the
 * anonymous dataset of the toolset's BigQuery session.
 */
async function gateProtected(
  client: BigQuery,
  query: string,
  labels: Record<string, string>,
  toolContext?: Context,
): Promise<WriteModeDecision> {
  const [sessionId, sessionDatasetId] = await resolveSession(
    client,
    labels,
    toolContext,
  );
  const connectionProperties: ConnectionProperty[] = [
    {key: 'session_id', value: sessionId},
  ];

  const resource = await dryRunQuery(
    client,
    query,
    labels,
    connectionProperties,
  );
  const destination = destinationDatasetId(resource);
  if (
    statementType(resource) !== 'SELECT' &&
    destination &&
    destination !== sessionDatasetId
  ) {
    return {
      error: bigQueryToolError(
        'Protected write mode only supports SELECT statements, or write' +
          ' operations in the anonymous dataset of a BigQuery session.',
      ),
      connectionProperties,
    };
  }
  return {connectionProperties};
}

/** Runs the write-mode gate for the toolset's configured mode. */
function applyWriteMode(
  client: BigQuery,
  query: string,
  labels: Record<string, string>,
  settings: ResolvedBigQueryToolConfig,
  toolContext?: Context,
): Promise<WriteModeDecision> {
  switch (settings.writeMode) {
    case WriteMode.BLOCKED:
      return gateBlocked(client, query, labels);
    case WriteMode.PROTECTED:
      return gateProtected(client, query, labels, toolContext);
    default:
      return Promise.resolve({connectionProperties: []});
  }
}

/**
 * Returns a cell value the result can carry, stringifying one that JSON
 * cannot represent rather than failing the whole result.
 */
function serializeCell(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

/** Turns the client's rows into the rows the model reads. */
function serializeRows(rows: ReadonlyArray<BigQueryRow>): BigQueryRow[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, serializeCell(value)]),
    ),
  );
}

/** What one query run needs. */
interface RunQueryRequest {
  projectId: string;
  query: string;
  callerId: string;
  dryRun?: boolean;
  toolContext?: Context;
}

/**
 * Runs one query through the compute guardrail, the write-mode gate and the
 * result-size cap. Every BigQuery query tool goes through here, as
 * adk-python's `_execute_sql` does.
 *
 * @param deps The clients and settings of the owning toolset.
 * @param request The query and who is asking for it.
 * @return The rows, the dry-run description, or the failure envelope.
 */
export async function runQuery(
  deps: BigQueryToolDeps,
  request: RunQueryRequest,
): Promise<ExecuteSqlResult> {
  const {settings} = deps;
  return runBigQueryTool<
    BigQueryRowsResult | BigQueryDryRunResult | BigQueryToolError
  >(async () => {
    if (
      settings.computeProjectId &&
      request.projectId !== settings.computeProjectId
    ) {
      return bigQueryToolError(
        `Cannot execute query in the project ${request.projectId}, as the` +
          ` tool is restricted to execute queries only in the project` +
          ` ${settings.computeProjectId}.`,
      );
    }

    const client = await getToolClient(
      deps,
      request.projectId,
      request.callerId,
    );
    const labels = buildJobLabels(settings, request.callerId);
    const decision = await applyWriteMode(
      client,
      request.query,
      labels,
      settings,
      request.toolContext,
    );
    if (decision.error) {
      return decision.error;
    }

    if (request.dryRun) {
      return {
        status: 'SUCCESS',
        dry_run_info: await dryRunQuery(
          client,
          request.query,
          labels,
          decision.connectionProperties,
        ),
      };
    }

    const [job] = await client.createQueryJob({
      query: request.query,
      labels,
      connectionProperties: decision.connectionProperties,
      maximumBytesBilled: settings.maximumBytesBilled
        ? String(settings.maximumBytesBilled)
        : undefined,
    });
    const [rawRows]: [BigQueryRow[], ...unknown[]] = await job.getQueryResults({
      maxResults: settings.maxQueryResultRows,
    });

    const rows = serializeRows(rawRows);
    const result: BigQueryRowsResult = {status: 'SUCCESS', rows};
    if (rows.length === settings.maxQueryResultRows) {
      result.result_is_likely_truncated = true;
    }
    return result;
  });
}

/**
 * Runs a BigQuery or BigQuery ML SQL query and returns its result.
 *
 * @param input The project, the query and whether to only describe it.
 * @param deps The clients and settings of the owning toolset.
 * @param toolContext The call's context, holding the BigQuery session.
 * @return The rows, the dry-run description, or the failure envelope.
 */
export function executeSql(
  input: z.infer<typeof EXECUTE_SQL_PARAMETERS>,
  deps: BigQueryToolDeps,
  toolContext?: Context,
): Promise<ExecuteSqlResult> {
  return runQuery(deps, {
    projectId: input.project_id,
    query: input.query,
    dryRun: input.dry_run,
    callerId: 'execute_sql',
    toolContext,
  });
}

/**
 * Returns the deps a BigQuery ML tool runs its `CREATE TEMP MODEL` under.
 *
 * A temporary model needs a BigQuery session, so a toolset in
 * {@link WriteMode.ALLOWED} is narrowed to {@link WriteMode.PROTECTED} for the
 * two statements. A toolset in {@link WriteMode.BLOCKED} refuses outright.
 */
function withModelSession(
  deps: BigQueryToolDeps,
  toolName: string,
): BigQueryToolDeps | BigQueryToolError {
  if (deps.settings.writeMode === WriteMode.BLOCKED) {
    return bigQueryToolError(`${toolName} is not allowed in this session.`);
  }
  if (deps.settings.writeMode === WriteMode.PROTECTED) {
    return deps;
  }
  return {
    ...deps,
    settings: {...deps.settings, writeMode: WriteMode.PROTECTED},
  };
}

/** Whether a value is the failure envelope rather than a tool's deps. */
function isToolError(
  value: BigQueryToolDeps | BigQueryToolError,
): value is BigQueryToolError {
  return 'status' in value;
}

/** Names a temporary BigQuery ML model uniquely within the session. */
function temporaryModelName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '_')}`;
}

/**
 * Runs a `CREATE TEMP MODEL` statement and then the statement that reads it,
 * both in the same BigQuery session.
 */
async function runModelQueries(
  deps: BigQueryToolDeps,
  request: {
    projectId: string;
    createModelQuery: string;
    readModelQuery: string;
    callerId: string;
    toolContext?: Context;
  },
): Promise<ExecuteSqlResult> {
  const created = await runQuery(deps, {
    projectId: request.projectId,
    query: request.createModelQuery,
    callerId: request.callerId,
    toolContext: request.toolContext,
  });
  if (created.status !== 'SUCCESS') {
    return created;
  }
  return runQuery(deps, {
    projectId: request.projectId,
    query: request.readModelQuery,
    callerId: request.callerId,
    toolContext: request.toolContext,
  });
}

/**
 * Checks a data source argument and renders it as a SQL source expression.
 *
 * @param source The `history_data`, `input_data` or `target_data` argument.
 * @param renderTable How to render the argument when it names a table.
 * @param deps The clients and settings of the owning toolset.
 * @param projectId The project the dry run runs in.
 * @param callerId The calling tool, for the dry run's job labels.
 * @return The source expression, or the failure envelope.
 */
async function resolveDataSource(
  source: string,
  renderTable: (tableId: string) => string,
  deps: BigQueryToolDeps,
  projectId: string,
  callerId: string,
): Promise<string | BigQueryToolError> {
  if (!isSubquery(source)) {
    return isValidTableIdentifier(source)
      ? renderTable(source)
      : bigQueryToolError(invalidIdentifierMessage(source));
  }
  const error = await validateSubquery(source, deps, projectId, callerId);
  return error ?? `(${source})`;
}

/** The HTTP status of a Google API error, when it carries one. */
function errorStatusCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return typeof err.code === 'number' ? err.code : undefined;
  }
  return undefined;
}

/**
 * Dry-runs a caller-supplied subquery and checks that it only reads.
 *
 * @param subquery The query the caller passed as a data source.
 * @param deps The clients and settings of the owning toolset.
 * @param projectId The project the dry run runs in.
 * @param callerId The calling tool, for the job labels.
 * @return The failure envelope, or `undefined` when the subquery is a read.
 */
export async function validateSubquery(
  subquery: string,
  deps: BigQueryToolDeps,
  projectId: string,
  callerId: string,
): Promise<BigQueryToolError | undefined> {
  try {
    const client = await getToolClient(deps, projectId, callerId);
    const labels = buildJobLabels(deps.settings, callerId);
    const resource = await dryRunQuery(client, subquery, labels, []);
    if (statementType(resource) !== 'SELECT') {
      return bigQueryToolError('Subquery must be a SELECT statement.');
    }
    return undefined;
  } catch (err: unknown) {
    const status = errorStatusCode(err);
    const message = err instanceof Error ? err.message : String(err);
    if (status === 400 || status === 404) {
      return bigQueryToolError(`Invalid subquery: ${message}`);
    }
    return bigQueryToolError(`Subquery dry run validation failed: ${message}`);
  }
}

/** Checks every column identifier, returning the first failure. */
function checkColumnIdentifiers(
  columns: ReadonlyArray<string>,
): BigQueryToolError | undefined {
  for (const column of columns) {
    if (!isValidColumnIdentifier(column)) {
      return bigQueryToolError(invalidIdentifierMessage(column));
    }
  }
  return undefined;
}

/**
 * Forecasts a time series with BigQuery's `AI.FORECAST`.
 *
 * @param input The history data, the columns to read and the horizon.
 * @param deps The clients and settings of the owning toolset.
 * @param toolContext The call's context, holding the BigQuery session.
 * @return The forecast rows, or the failure envelope.
 */
export async function forecast(
  input: z.infer<typeof FORECAST_PARAMETERS>,
  deps: BigQueryToolDeps,
  toolContext?: Context,
): Promise<ExecuteSqlResult> {
  const horizon = Math.trunc(input.horizon ?? DEFAULT_FORECAST_HORIZON);
  const idCols = input.id_cols ?? [];

  const source = await resolveDataSource(
    input.history_data,
    (tableId) => `TABLE \`${tableId}\``,
    deps,
    input.project_id,
    'forecast',
  );
  if (typeof source !== 'string') {
    return source;
  }

  const columnError = checkColumnIdentifiers([
    input.data_col,
    input.timestamp_col,
  ]);
  if (columnError) {
    return columnError;
  }
  if (idCols.length > 0 && !idCols.every(isValidColumnIdentifier)) {
    return bigQueryToolError(
      'All elements in id_cols must be valid identifiers.',
    );
  }

  const idColsOption =
    idCols.length > 0
      ? `\n    id_cols => ${toIdentifierArrayLiteral(idCols)},`
      : '';
  const query = `
  SELECT * FROM AI.FORECAST(
    ${source},
    data_col => '${input.data_col}',
    timestamp_col => '${input.timestamp_col}',
    model => '${FORECAST_MODEL}',${idColsOption}
    horizon => ${horizon},
    confidence_level => ${FORECAST_CONFIDENCE_LEVEL}
  )
  `;

  return runQuery(deps, {
    projectId: input.project_id,
    query,
    callerId: 'forecast',
    toolContext,
  });
}

/**
 * Explains the difference between a test and a control population with
 * BigQuery ML contribution analysis.
 *
 * @param input The input data, the metric and the dimensions to attribute to.
 * @param deps The clients and settings of the owning toolset.
 * @param toolContext The call's context, holding the BigQuery session.
 * @return The insight rows, or the failure envelope.
 */
export async function analyzeContribution(
  input: z.infer<typeof ANALYZE_CONTRIBUTION_PARAMETERS>,
  deps: BigQueryToolDeps,
  toolContext?: Context,
): Promise<ExecuteSqlResult> {
  const topKInsights = Math.trunc(
    input.top_k_insights ?? DEFAULT_TOP_K_INSIGHTS,
  );
  const pruningMethod = (
    input.pruning_method ?? 'PRUNE_REDUNDANT_INSIGHTS'
  ).toUpperCase();

  if (!input.dimension_id_cols.every(isValidColumnIdentifier)) {
    return bigQueryToolError(
      'All elements in dimension_id_cols must be valid identifiers.',
    );
  }
  const columnError = checkColumnIdentifiers([input.is_test_col]);
  if (columnError) {
    return columnError;
  }
  if (!PRUNING_METHODS.includes(pruningMethod)) {
    return bigQueryToolError(`Invalid pruning_method: ${input.pruning_method}`);
  }

  const source = await resolveDataSource(
    input.input_data,
    (tableId) => `SELECT * FROM \`${tableId}\``,
    deps,
    input.project_id,
    'analyze_contribution',
  );
  if (typeof source !== 'string') {
    return source;
  }

  const modelDeps = withModelSession(deps, 'analyze_contribution');
  if (isToolError(modelDeps)) {
    return modelDeps;
  }

  const modelName = temporaryModelName('contribution_analysis_model');
  const options = [
    "MODEL_TYPE = 'CONTRIBUTION_ANALYSIS'",
    `CONTRIBUTION_METRIC = '${escapeSingleQuotes(input.contribution_metric)}'`,
    `IS_TEST_COL = '${input.is_test_col}'`,
    `DIMENSION_ID_COLS = ${toIdentifierArrayLiteral(input.dimension_id_cols)}`,
    `TOP_K_INSIGHTS_BY_APRIORI_SUPPORT = ${topKInsights}`,
    `PRUNING_METHOD = '${pruningMethod}'`,
  ].join(', ');

  return runModelQueries(modelDeps, {
    projectId: input.project_id,
    createModelQuery: `
  CREATE TEMP MODEL ${modelName}
    OPTIONS (${options})
  AS ${source}
  `,
    readModelQuery: `
  SELECT * FROM ML.GET_INSIGHTS(MODEL ${modelName})
  `,
    callerId: 'analyze_contribution',
    toolContext,
  });
}

/**
 * Finds anomalies in a time series with a BigQuery ML `ARIMA_PLUS` model.
 *
 * @param input The history data, the columns to read and the threshold.
 * @param deps The clients and settings of the owning toolset.
 * @param toolContext The call's context, holding the BigQuery session.
 * @return The anomaly rows, or the failure envelope.
 */
export async function detectAnomalies(
  input: z.infer<typeof DETECT_ANOMALIES_PARAMETERS>,
  deps: BigQueryToolDeps,
  toolContext?: Context,
): Promise<ExecuteSqlResult> {
  const horizon = Math.trunc(input.horizon ?? DEFAULT_ANOMALY_HORIZON);
  const threshold =
    input.anomaly_prob_threshold ?? DEFAULT_ANOMALY_PROB_THRESHOLD;
  const idCols = input.times_series_id_cols ?? [];

  const columnError = checkColumnIdentifiers([
    input.times_series_timestamp_col,
    input.times_series_data_col,
  ]);
  if (columnError) {
    return columnError;
  }
  const source = await resolveDataSource(
    input.history_data,
    (tableId) => `SELECT * FROM \`${tableId}\``,
    deps,
    input.project_id,
    'detect_anomalies',
  );
  if (typeof source !== 'string') {
    return source;
  }

  if (idCols.length > 0 && !idCols.every(isValidColumnIdentifier)) {
    return bigQueryToolError(
      'All elements in times_series_id_cols must be valid identifiers.',
    );
  }

  const target = await resolveTargetData(input.target_data);
  if (typeof target !== 'string' && target !== undefined) {
    return target;
  }

  const modelDeps = withModelSession(deps, 'anomaly detection');
  if (isToolError(modelDeps)) {
    return modelDeps;
  }

  const options = [
    "MODEL_TYPE = 'ARIMA_PLUS'",
    `TIME_SERIES_TIMESTAMP_COL = '${input.times_series_timestamp_col}'`,
    `TIME_SERIES_DATA_COL = '${input.times_series_data_col}'`,
    `HORIZON = ${horizon}`,
    ...(idCols.length > 0
      ? [`TIME_SERIES_ID_COL = ${toIdentifierArrayLiteral(idCols)}`]
      : []),
  ].join(', ');

  const modelName = temporaryModelName('detect_anomalies_model');
  const orderByIdCols = idCols.map((column) => `\`${column}\`, `).join('');
  const targetArgument = target ? `, ${target}` : '';

  return runModelQueries(modelDeps, {
    projectId: input.project_id,
    createModelQuery: `
  CREATE TEMP MODEL ${modelName}
    OPTIONS (${options})
  AS ${source}
  `,
    readModelQuery: `
  SELECT * FROM ML.DETECT_ANOMALIES(MODEL ${modelName}, STRUCT(${threshold} AS anomaly_prob_threshold)${targetArgument}) ORDER BY ${orderByIdCols}\`${input.times_series_timestamp_col}\`
  `,
    callerId: 'detect_anomalies',
    toolContext,
  });
}

/**
 * Renders the optional `target_data` argument of `detect_anomalies`.
 *
 * Unlike the history data, a target query is not dry-run: adk-python does not
 * validate it either, because it is only ever wrapped in parentheses and
 * passed to `ML.DETECT_ANOMALIES` as a subquery.
 */
function resolveTargetData(
  targetData: string | undefined,
): string | BigQueryToolError | undefined {
  if (!targetData) {
    return undefined;
  }
  if (isSubquery(targetData)) {
    return `(${targetData})`;
  }
  return isValidTableIdentifier(targetData)
    ? `(SELECT * FROM \`${targetData}\`)`
    : bigQueryToolError(invalidIdentifierMessage(targetData));
}

/**
 * Builds `execute_sql` and the three BigQuery ML tools.
 *
 * @param deps The clients and settings of the owning toolset.
 * @return The tools, in adk-python's declaration order.
 */
export function createQueryTools(deps: BigQueryToolDeps): BaseTool[] {
  return [
    new FunctionTool({
      name: 'execute_sql',
      description: executeSqlDescription(deps.settings.writeMode),
      parameters: EXECUTE_SQL_PARAMETERS,
      execute: (input, toolContext) => executeSql(input, deps, toolContext),
    }),
    new FunctionTool({
      name: 'forecast',
      description:
        'Run a BigQuery AI time series forecast using AI.FORECAST, and ' +
        'return the forecast values with their prediction intervals.',
      parameters: FORECAST_PARAMETERS,
      execute: (input, toolContext) => forecast(input, deps, toolContext),
    }),
    new FunctionTool({
      name: 'analyze_contribution',
      description:
        'Run a BigQuery ML contribution analysis, and return which ' +
        'dimension values explain the difference between the test and the ' +
        'control data.',
      parameters: ANALYZE_CONTRIBUTION_PARAMETERS,
      execute: (input, toolContext) =>
        analyzeContribution(input, deps, toolContext),
    }),
    new FunctionTool({
      name: 'detect_anomalies',
      description:
        'Train a BigQuery ML ARIMA_PLUS model on a time series and return ' +
        'the points ML.DETECT_ANOMALIES marks as anomalous.',
      parameters: DETECT_ANOMALIES_PARAMETERS,
      execute: (input, toolContext) =>
        detectAnomalies(input, deps, toolContext),
    }),
  ];
}
