/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQuery, JobMetadata, Query} from '@google-cloud/bigquery';
import {randomUUID} from 'node:crypto';

import {Context} from '../../agents/context.js';
import {
  GoogleToolErrorResponse,
  GoogleToolStatus,
} from '../../tools/google_tool.js';
import {formatError} from '../../utils/error_utils.js';

import {
  APPLICATION_NAME_JOB_LABEL,
  BigQueryToolSettings,
  TOOL_NAME_JOB_LABEL,
  WriteMode,
} from './config.js';

/** The session-state key holding the BigQuery session a tool call opened. */
export const BIGQUERY_SESSION_INFO_KEY = 'bigquery_session_info';

/**
 * A BigQuery session, as it is kept in session state.
 *
 * adk-python stores a `(session_id, dataset_id)` tuple under the same key, so
 * the pair stays positional rather than becoming a named object.
 */
export type BigQuerySessionInfo = [sessionId: string, datasetId: string];

/** The statement type BigQuery reports for a plain read. */
const SELECT_STATEMENT = 'SELECT';

/** The connection property associating a query with a BigQuery session. */
const SESSION_ID_PROPERTY = 'session_id';

/** Why the write-mode guard refused a statement. */
export enum WriteModeRefusal {
  BLOCKED = 'Read-only mode only supports SELECT statements.',
  PROTECTED = 'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
}

/** What an `execute_sql` family call returns when it succeeds. */
export interface QuerySuccessResponse {
  status: GoogleToolStatus.SUCCESS;
  /** The rows the query returned. Absent when the call was a dry run. */
  rows?: Array<Record<string, unknown>>;
  /**
   * Set when the row cap was reached, so further matching rows may exist. The
   * key crosses the language boundary, so it stays snake_case.
   */
  result_is_likely_truncated?: boolean;
  /** What BigQuery reported about the query. Only set for a dry run. */
  dry_run_info?: JobMetadata;
}

/** What an `execute_sql` family call returns. */
export type QueryResponse = QuerySuccessResponse | GoogleToolErrorResponse;

/** What {@link executeSqlQuery} needs to run one statement. */
export interface ExecuteSqlOptions {
  /** The client to run through, already carrying the caller's user agent. */
  client: BigQuery;
  /** The project the query is billed to. */
  projectId: string;
  /** The statement to run. */
  query: string;
  /** The settings the owning toolset was configured with. */
  settings: BigQueryToolSettings;
  /** The call's context, used to remember a BigQuery session. */
  toolContext?: Context;
  /** Validate and cost the query instead of running it. */
  dryRun?: boolean;
  /** The tool that started the job, recorded as a job label. */
  callerId: string;
}

/** Builds the structured failure a tool returns instead of throwing. */
function errorResponse(message: string): GoogleToolErrorResponse {
  return {status: GoogleToolStatus.ERROR, error_details: message};
}

/** The labels every job a tool starts carries. */
function jobLabels(
  settings: BigQueryToolSettings,
  callerId: string,
): Record<string, string> {
  const labels = {...settings.jobLabels};
  labels[TOOL_NAME_JOB_LABEL] = callerId;
  if (settings.applicationName) {
    labels[APPLICATION_NAME_JOB_LABEL] = settings.applicationName;
  }
  return labels;
}

/** Runs a query in dry-run mode and returns the job BigQuery planned. */
async function planQuery(
  client: BigQuery,
  request: Query,
): Promise<JobMetadata> {
  const [job] = await client.createQueryJob({...request, dryRun: true});
  const metadata: JobMetadata = job.metadata;
  return metadata;
}

/** The kind of statement BigQuery decided a query is. */
function statementTypeOf(job: JobMetadata): string | undefined {
  return job.statistics?.query?.statementType ?? undefined;
}

/** The anonymous dataset a planned job would write its output to. */
function destinationDatasetOf(job: JobMetadata): string | undefined {
  return job.configuration?.query?.destinationTable?.datasetId ?? undefined;
}

/** Either a refusal, or the connection properties the query must carry. */
type WriteModeDecision =
  | {refusal: WriteModeRefusal}
  | {connectionProperties: Query['connectionProperties']};

/** Rejects anything but a read. */
async function checkReadOnly(
  client: BigQuery,
  request: Query,
): Promise<WriteModeDecision> {
  const planned = await planQuery(client, request);
  if (statementTypeOf(planned) !== SELECT_STATEMENT) {
    return {refusal: WriteModeRefusal.BLOCKED};
  }
  return {connectionProperties: undefined};
}

/**
 * Returns the BigQuery session for this conversation, opening one if the
 * context does not already hold it.
 */
async function resolveSession(
  client: BigQuery,
  request: Query,
  toolContext?: Context,
): Promise<BigQuerySessionInfo> {
  const remembered = toolContext?.state.get<BigQuerySessionInfo>(
    BIGQUERY_SESSION_INFO_KEY,
  );
  if (remembered) {
    return remembered;
  }
  const planned = await planQuery(client, {
    ...request,
    query: 'SELECT 1',
    createSession: true,
  });
  const session: BigQuerySessionInfo = [
    planned.statistics?.sessionInfo?.sessionId ?? '',
    destinationDatasetOf(planned) ?? '',
  ];
  toolContext?.state.set(BIGQUERY_SESSION_INFO_KEY, session);
  return session;
}

/**
 * Allows a read, and a write that lands in the anonymous dataset of the
 * conversation's BigQuery session. Rejects a write anywhere else.
 */
async function checkProtected(
  client: BigQuery,
  request: Query,
  toolContext?: Context,
): Promise<WriteModeDecision> {
  const [sessionId, sessionDatasetId] = await resolveSession(
    client,
    request,
    toolContext,
  );
  const connectionProperties = [{key: SESSION_ID_PROPERTY, value: sessionId}];
  const planned = await planQuery(client, {...request, connectionProperties});
  const destination = destinationDatasetOf(planned);
  if (
    statementTypeOf(planned) !== SELECT_STATEMENT &&
    destination &&
    destination !== sessionDatasetId
  ) {
    return {refusal: WriteModeRefusal.PROTECTED};
  }
  return {connectionProperties};
}

/** Applies the configured write mode to a statement before it runs. */
function applyWriteMode(
  client: BigQuery,
  request: Query,
  settings: BigQueryToolSettings,
  toolContext?: Context,
): Promise<WriteModeDecision> {
  switch (settings.writeMode) {
    case WriteMode.BLOCKED:
      return checkReadOnly(client, request);
    case WriteMode.PROTECTED:
      return checkProtected(client, request, toolContext);
    default:
      return Promise.resolve({connectionProperties: undefined});
  }
}

/**
 * Returns a value the tool result can carry as JSON.
 *
 * BigQuery hands back values JSON cannot hold — a `BigQueryDate`, a `Buffer`,
 * a `BigInt`. adk-python stringifies those, and so does this.
 */
function jsonSafe(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

/** Reshapes one BigQuery row so every value survives JSON encoding. */
function safeRow(row: unknown): Record<string, unknown> {
  const entries = Object.entries(row as Record<string, unknown>);
  return Object.fromEntries(
    entries.map(([key, value]) => [key, jsonSafe(value)]),
  );
}

/** Runs the statement and collects at most the configured number of rows. */
async function runQuery(
  client: BigQuery,
  request: Query,
  settings: BigQueryToolSettings,
): Promise<QuerySuccessResponse> {
  const response = await client.query({
    ...request,
    maximumBytesBilled: settings.maximumBytesBilled
      ? String(settings.maximumBytesBilled)
      : undefined,
    maxResults: settings.maxQueryResultRows,
  });
  const rawRows: unknown[] = response[0];
  const rows = rawRows.map(safeRow);
  const result: QuerySuccessResponse = {
    status: GoogleToolStatus.SUCCESS,
    rows,
  };
  if (rows.length === settings.maxQueryResultRows) {
    result.result_is_likely_truncated = true;
  }
  return result;
}

/**
 * Runs one BigQuery statement under the configured write mode.
 *
 * Failures come back as {@link GoogleToolErrorResponse} rather than being
 * thrown, because {@link analyzeContribution} and {@link detectAnomalies}
 * chain two calls and stop on the first that did not succeed.
 *
 * @param options The client, the statement and the settings to run it under.
 * @return The rows, the dry-run report, or the failure.
 */
export async function executeSqlQuery(
  options: ExecuteSqlOptions,
): Promise<QueryResponse> {
  const {client, projectId, query, settings, toolContext, dryRun, callerId} =
    options;
  try {
    if (settings.computeProjectId && projectId !== settings.computeProjectId) {
      return errorResponse(
        `Cannot execute query in the project ${projectId}, as the tool is` +
          ` restricted to execute queries only in the project` +
          ` ${settings.computeProjectId}.`,
      );
    }

    const request: Query = {
      query,
      projectId,
      labels: jobLabels(settings, callerId),
    };
    const decision = await applyWriteMode(
      client,
      request,
      settings,
      toolContext,
    );
    if ('refusal' in decision) {
      return errorResponse(decision.refusal);
    }

    const {connectionProperties} = decision;
    if (dryRun) {
      const planned = await planQuery(client, {
        ...request,
        connectionProperties,
      });
      return {status: GoogleToolStatus.SUCCESS, dry_run_info: planned};
    }
    return await runQuery(client, {...request, connectionProperties}, settings);
  } catch (error: unknown) {
    return errorResponse(formatError(error));
  }
}

/** The part of `execute_sql`'s description that every write mode shares. */
const EXECUTE_SQL_SUMMARY =
  'Run a BigQuery or BigQuery ML SQL query in the project and return the' +
  ' result. Set dryRun to validate and cost a query without running it. A' +
  ' result carrying result_is_likely_truncated may have further matching' +
  ' rows that were not returned.';

/**
 * What `execute_sql` tells the model it may do, per write mode.
 *
 * adk-python swaps the tool's docstring for the same reason: the model has to
 * know which statements the runtime guard will accept.
 */
export const EXECUTE_SQL_DESCRIPTIONS: Readonly<Record<WriteMode, string>> = {
  [WriteMode.BLOCKED]: `${EXECUTE_SQL_SUMMARY} Only SELECT statements are accepted; any write is refused.`,
  [WriteMode.PROTECTED]:
    `${EXECUTE_SQL_SUMMARY} Besides SELECT, only writes inside the anonymous` +
    ' dataset of the BigQuery session are accepted, so create, fill and drop' +
    ' temporary objects: CREATE TEMP TABLE, CREATE TEMP MODEL, INSERT INTO a' +
    ' temporary table, DROP TABLE. Do not create, change or delete a' +
    ' permanent table or model. To replace a temporary object, use CREATE OR' +
    ' REPLACE TEMP, or DROP it first.',
  [WriteMode.ALLOWED]:
    `${EXECUTE_SQL_SUMMARY} Every statement is accepted, including CREATE` +
    ' TABLE, INSERT, DROP TABLE, CREATE SNAPSHOT TABLE, CREATE MODEL and DROP' +
    ' MODEL. To replace an existing object, use CREATE OR REPLACE, or DROP it' +
    ' first.',
};

/**
 * Escapes a value that is interpolated into a single-quoted SQL literal.
 *
 * Every identifier below arrives from the model, so a value carrying a quote
 * would otherwise close the literal it sits in. adk-python interpolates the
 * same values unescaped; this port does not.
 */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "\\'")}'`;
}

/** A SQL array literal of quoted column names. */
function quotedList(values: readonly string[]): string {
  return `[${values.map(quoteLiteral).join(', ')}]`;
}

/**
 * Reads `source` either as a subquery or as a table, whichever it is.
 *
 * @param source A SQL statement, or the id of a table.
 * @param tableForm How a table id is spelled in the statement being built.
 * @return The fragment naming the data.
 */
function dataSource(
  source: string,
  tableForm: (tableId: string) => string,
): string {
  const trimmed = source.trim().toUpperCase();
  return trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')
    ? `(${source})`
    : tableForm(source);
}

/** What {@link forecast} needs from the model. */
export interface ForecastOptions {
  projectId: string;
  historyData: string;
  timestampCol: string;
  dataCol: string;
  horizon?: number;
  idCols?: string[];
}

/** The forecasting model `AI.FORECAST` is asked for. */
const FORECAST_MODEL = 'TimesFM 2.0';

/** The prediction interval `AI.FORECAST` reports. */
const FORECAST_CONFIDENCE_LEVEL = 0.95;

/** How many steps ahead {@link forecast} predicts when the model says nothing. */
export const DEFAULT_FORECAST_HORIZON = 10;

/**
 * Forecasts a time series with `AI.FORECAST`.
 *
 * @param client The client to run through.
 * @param options The history data and the columns describing it.
 * @param settings The settings the owning toolset was configured with.
 * @param toolContext The call's context.
 * @return The forecast rows, or the failure.
 */
export function forecast(
  client: BigQuery,
  options: ForecastOptions,
  settings: BigQueryToolSettings,
  toolContext?: Context,
): Promise<QueryResponse> {
  const source = dataSource(
    options.historyData,
    (tableId) => `TABLE \`${tableId}\``,
  );
  const horizon = options.horizon ?? DEFAULT_FORECAST_HORIZON;
  const idCols = options.idCols?.length
    ? `\n    id_cols => ${quotedList(options.idCols)},`
    : '';
  const query = `
  SELECT * FROM AI.FORECAST(
    ${source},
    data_col => ${quoteLiteral(options.dataCol)},
    timestamp_col => ${quoteLiteral(options.timestampCol)},
    model => ${quoteLiteral(FORECAST_MODEL)},${idCols}
    horizon => ${horizon},
    confidence_level => ${FORECAST_CONFIDENCE_LEVEL}
  )
  `;
  return executeSqlQuery({
    client,
    projectId: options.projectId,
    query,
    settings,
    toolContext,
    callerId: 'forecast',
  });
}

/** How `ML.CREATE_MODEL` may prune the insights it reports. */
export const PRUNING_METHODS = [
  'NO_PRUNING',
  'PRUNE_REDUNDANT_INSIGHTS',
] as const;

/** One of {@link PRUNING_METHODS}. */
export type PruningMethod = (typeof PRUNING_METHODS)[number];

/** How many insights {@link analyzeContribution} reports by default. */
export const DEFAULT_TOP_K_INSIGHTS = 30;

/** What {@link analyzeContribution} needs from the model. */
export interface AnalyzeContributionOptions {
  projectId: string;
  inputData: string;
  contributionMetric: string;
  dimensionIdCols: string[];
  isTestCol: string;
  topKInsights?: number;
  pruningMethod?: string;
}

/**
 * A model name no other call will pick, so two analyses in one session do not
 * overwrite each other's temporary model.
 */
function temporaryModelName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '_')}`;
}

/**
 * The settings a temporary model may be created under.
 *
 * `CREATE TEMP MODEL` needs a BigQuery session, so an allow-everything
 * configuration is narrowed to the protected mode that opens one. A blocked
 * configuration is refused instead.
 */
function settingsForTemporaryModel(
  settings: BigQueryToolSettings,
  operation: string,
): BigQueryToolSettings {
  if (settings.writeMode === WriteMode.BLOCKED) {
    throw new Error(`${operation} is not allowed in this session.`);
  }
  return {...settings, writeMode: WriteMode.PROTECTED};
}

/** Runs `create`, then `read` only if the first call succeeded. */
async function runModelQueries(
  client: BigQuery,
  projectId: string,
  queries: {create: string; read: string},
  settings: BigQueryToolSettings,
  callerId: string,
  toolContext?: Context,
): Promise<QueryResponse> {
  const created = await executeSqlQuery({
    client,
    projectId,
    query: queries.create,
    settings,
    toolContext,
    callerId,
  });
  if (created.status !== GoogleToolStatus.SUCCESS) {
    return created;
  }
  return executeSqlQuery({
    client,
    projectId,
    query: queries.read,
    settings,
    toolContext,
    callerId,
  });
}

/**
 * Explains a change in a metric with `ML.GET_INSIGHTS`.
 *
 * @param client The client to run through.
 * @param options The test and control data, and the columns describing it.
 * @param settings The settings the owning toolset was configured with.
 * @param toolContext The call's context.
 * @return The insight rows, or the failure.
 * @throws {Error} If the toolset blocks writes, since the analysis has to
 *     create a temporary model.
 */
export async function analyzeContribution(
  client: BigQuery,
  options: AnalyzeContributionOptions,
  settings: BigQueryToolSettings,
  toolContext?: Context,
): Promise<QueryResponse> {
  const pruningMethod = options.pruningMethod ?? PRUNING_METHODS[1];
  const upperPruning = pruningMethod.toUpperCase();
  if (!PRUNING_METHODS.includes(upperPruning as PruningMethod)) {
    return errorResponse(`Invalid pruning_method: ${pruningMethod}`);
  }

  const modelName = temporaryModelName('contribution_analysis_model');
  const modelOptions = [
    "MODEL_TYPE = 'CONTRIBUTION_ANALYSIS'",
    `CONTRIBUTION_METRIC = ${quoteLiteral(options.contributionMetric)}`,
    `IS_TEST_COL = ${quoteLiteral(options.isTestCol)}`,
    `DIMENSION_ID_COLS = ${quotedList(options.dimensionIdCols)}`,
    `TOP_K_INSIGHTS_BY_APRIORI_SUPPORT = ${options.topKInsights ?? DEFAULT_TOP_K_INSIGHTS}`,
    `PRUNING_METHOD = ${quoteLiteral(upperPruning)}`,
  ].join(', ');
  const source = dataSource(
    options.inputData,
    (tableId) => `SELECT * FROM \`${tableId}\``,
  );

  return runModelQueries(
    client,
    options.projectId,
    {
      create: `
  CREATE TEMP MODEL ${modelName}
    OPTIONS (${modelOptions})
  AS ${source}
  `,
      read: `
  SELECT * FROM ML.GET_INSIGHTS(MODEL ${modelName})
  `,
    },
    settingsForTemporaryModel(settings, 'analyze_contribution'),
    'analyze_contribution',
    toolContext,
  );
}

/** How far ahead {@link detectAnomalies} trains when the model says nothing. */
export const DEFAULT_ANOMALY_HORIZON = 1000;

/** The default probability above which a point counts as an anomaly. */
export const DEFAULT_ANOMALY_PROB_THRESHOLD = 0.95;

/** What {@link detectAnomalies} needs from the model. */
export interface DetectAnomaliesOptions {
  projectId: string;
  historyData: string;
  timesSeriesTimestampCol: string;
  timesSeriesDataCol: string;
  horizon?: number;
  targetData?: string;
  timesSeriesIdCols?: string[];
  anomalyProbThreshold?: number;
}

/**
 * Trains an `ARIMA_PLUS` model and reports the anomalies it finds.
 *
 * @param client The client to run through.
 * @param options The history data and the columns describing it.
 * @param settings The settings the owning toolset was configured with.
 * @param toolContext The call's context.
 * @return The anomaly rows, or the failure.
 * @throws {Error} If the toolset blocks writes, since the detection has to
 *     create a temporary model.
 */
export async function detectAnomalies(
  client: BigQuery,
  options: DetectAnomaliesOptions,
  settings: BigQueryToolSettings,
  toolContext?: Context,
): Promise<QueryResponse> {
  const source = dataSource(
    options.historyData,
    (tableId) => `SELECT * FROM \`${tableId}\``,
  );
  const modelOptions = [
    "MODEL_TYPE = 'ARIMA_PLUS'",
    `TIME_SERIES_TIMESTAMP_COL = ${quoteLiteral(options.timesSeriesTimestampCol)}`,
    `TIME_SERIES_DATA_COL = ${quoteLiteral(options.timesSeriesDataCol)}`,
    `HORIZON = ${options.horizon ?? DEFAULT_ANOMALY_HORIZON}`,
  ];
  const idCols = options.timesSeriesIdCols ?? [];
  if (idCols.length) {
    modelOptions.push(`TIME_SERIES_ID_COL = ${quotedList(idCols)}`);
  }
  const modelName = temporaryModelName('detect_anomalies_model');
  const orderBy = [...idCols, options.timesSeriesTimestampCol].join(', ');
  const threshold =
    options.anomalyProbThreshold ?? DEFAULT_ANOMALY_PROB_THRESHOLD;
  const target = options.targetData
    ? `, ${dataSource(options.targetData, (tableId) => `(SELECT * FROM \`${tableId}\`)`)}`
    : '';

  return runModelQueries(
    client,
    options.projectId,
    {
      create: `
  CREATE TEMP MODEL ${modelName}
    OPTIONS (${modelOptions.join(', ')})
  AS ${source}
  `,
      read: `
  SELECT * FROM ML.DETECT_ANOMALIES(MODEL ${modelName}, STRUCT(${threshold} AS anomaly_prob_threshold)${target}) ORDER BY ${orderBy}
  `,
    },
    settingsForTemporaryModel(settings, 'anomaly detection'),
    'detect_anomalies',
    toolContext,
  );
}
