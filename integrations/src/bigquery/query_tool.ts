/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQuery, JobMetadata, Query} from '@google-cloud/bigquery';
import {Context, FunctionTool} from '@google/adk';
import {z} from 'zod';

import {getBigQueryClient} from './client.js';
import {WriteMode} from './config.js';
import {
  EXECUTE_SQL_PROTECTED_WRITE_DESCRIPTION,
  EXECUTE_SQL_READ_ONLY_DESCRIPTION,
  EXECUTE_SQL_WRITE_DESCRIPTION,
} from './query_tool_descriptions.js';
import {BigQueryToolDependencies, toolName} from './tool_dependencies.js';
import {
  BigQueryToolError,
  BigQueryToolStatus,
  bigQueryToolError,
  toBigQueryToolError,
} from './tool_error.js';

/**
 * Session-state key holding the BigQuery session a protected write reuses.
 *
 * The key and the two-element array shape come from adk-python, where the
 * value is a tuple. A session store that a Python agent and a TypeScript agent
 * share stays readable by both.
 */
export const BIGQUERY_SESSION_INFO_KEY = 'bigquery_session_info';

/** The model-facing name of the SQL tool. */
export const EXECUTE_SQL_TOOL_NAME = 'execute_sql';

/** The one statement type a read-only mode admits. */
const SELECT_STATEMENT_TYPE = 'SELECT';

/** The query that opens a BigQuery session without touching any data. */
const SESSION_CREATOR_QUERY = 'SELECT 1';

/** The connection property that binds a query to a BigQuery session. */
const SESSION_ID_PROPERTY = 'session_id';

const EXECUTE_SQL_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the query should be executed.'),
  query: z.string().describe('The BigQuery SQL query to be executed.'),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      'If true, the query is validated and described but not executed. ' +
        'Defaults to false.',
    ),
});

/** The rows a query returned, and whether more of them likely exist. */
export interface BigQueryQueryResult {
  status: BigQueryToolStatus.SUCCESS;
  rows: Array<Record<string, unknown>>;
  result_is_likely_truncated?: boolean;
}

/** What BigQuery reports about a query it did not run. */
export interface BigQueryDryRunResult {
  status: BigQueryToolStatus.SUCCESS;
  dry_run_info: JobMetadata;
}

/** Everything `execute_sql` can return to the model. */
export type ExecuteSqlResult =
  | BigQueryQueryResult
  | BigQueryDryRunResult
  | BigQueryToolError;

/** The BigQuery session a protected write runs inside. */
interface BigQuerySession {
  sessionId?: string;
  datasetId?: string;
}

/** The facts about a query that BigQuery reports from a dry run. */
interface DryRunFacts {
  statementType?: string;
  destinationDatasetId?: string;
  sessionId?: string;
}

/** The description that tells the model what this write mode admits. */
function executeSqlDescription(writeMode: WriteMode): string {
  switch (writeMode) {
    case WriteMode.ALLOWED:
      return EXECUTE_SQL_WRITE_DESCRIPTION;
    case WriteMode.PROTECTED:
      return EXECUTE_SQL_PROTECTED_WRITE_DESCRIPTION;
    default:
      return EXECUTE_SQL_READ_ONLY_DESCRIPTION;
  }
}

/** The labels every job this tool runs carries. */
function jobLabels(deps: BigQueryToolDependencies): Record<string, string> {
  const labels = {...deps.settings.jobLabels};
  labels['adk-bigquery-tool'] = EXECUTE_SQL_TOOL_NAME;
  if (deps.settings.applicationName) {
    labels['adk-bigquery-application-name'] = deps.settings.applicationName;
  }
  return labels;
}

/** Asks BigQuery to classify a query without running it. */
async function dryRun(client: BigQuery, request: Query): Promise<DryRunFacts> {
  const [job] = await client.createQueryJob({...request, dryRun: true});
  const metadata: JobMetadata = job.metadata;
  return {
    statementType: metadata.statistics?.query?.statementType,
    destinationDatasetId:
      metadata.configuration?.query?.destinationTable?.datasetId,
    sessionId: metadata.statistics?.sessionInfo?.sessionId,
  };
}

/**
 * The BigQuery session for a protected write, opening one on the first call.
 *
 * The session outlives the call, so it is remembered in the tool context and
 * every later query in the same agent session reuses it.
 */
async function resolveSession(
  client: BigQuery,
  labels: Query['labels'],
  toolContext?: Context,
): Promise<BigQuerySession> {
  const stored = toolContext?.state.get<[string, string]>(
    BIGQUERY_SESSION_INFO_KEY,
  );
  if (stored) {
    return {sessionId: stored[0], datasetId: stored[1]};
  }
  const facts = await dryRun(client, {
    query: SESSION_CREATOR_QUERY,
    createSession: true,
    labels,
  });
  const session = {
    sessionId: facts.sessionId,
    datasetId: facts.destinationDatasetId,
  };
  toolContext?.state.set(BIGQUERY_SESSION_INFO_KEY, [
    session.sessionId,
    session.datasetId,
  ]);
  return session;
}

/**
 * Rejects a query the write mode does not admit, and binds a protected query
 * to its session.
 *
 * BigQuery's own dry-run classification is the authority here. The query text
 * comes from the model, so matching strings against it would be guesswork.
 *
 * @param client The BigQuery client the dry run goes through.
 * @param request The query, carrying the labels and the session properties it
 *     will run with. A protected write gains its session property here.
 * @param writeMode What the caller configured the tool to admit.
 * @param toolContext The context holding the BigQuery session, when there is
 *     one.
 * @return The error to return to the model, or undefined when the query may
 *     run.
 */
async function guardWriteMode(
  client: BigQuery,
  request: Query,
  writeMode: WriteMode,
  toolContext?: Context,
): Promise<BigQueryToolError | undefined> {
  if (writeMode === WriteMode.ALLOWED) {
    return undefined;
  }
  if (writeMode === WriteMode.BLOCKED) {
    const facts = await dryRun(client, request);
    return facts.statementType === SELECT_STATEMENT_TYPE
      ? undefined
      : bigQueryToolError('Read-only mode only supports SELECT statements.');
  }
  const session = await resolveSession(client, request.labels, toolContext);
  request.connectionProperties = [
    {key: SESSION_ID_PROPERTY, value: session.sessionId},
  ];
  const facts = await dryRun(client, request);
  const writesOutsideSession =
    facts.statementType !== SELECT_STATEMENT_TYPE &&
    Boolean(facts.destinationDatasetId) &&
    facts.destinationDatasetId !== session.datasetId;
  return writesOutsideSession
    ? bigQueryToolError(
        'Protected write mode only supports SELECT statements, or write' +
          ' operations in the anonymous dataset of a BigQuery session.',
      )
    : undefined;
}

/** A value the model can read: the original, or its string form. */
function normalizeValue(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

/** A row whose every value survives JSON serialization. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  );
}

/** Runs the query and returns at most the configured number of rows. */
async function runQuery(
  client: BigQuery,
  request: Query,
  maxRows: number,
): Promise<BigQueryQueryResult> {
  const [allRows] = await client.query(request, {
    maxResults: maxRows,
    autoPaginate: false,
  });
  // The client paginates on its own, so the cap is applied to the response as
  // well as requested of the API.
  const rows: Array<Record<string, unknown>> = allRows.slice(0, maxRows);
  const result: BigQueryQueryResult = {
    status: BigQueryToolStatus.SUCCESS,
    rows: rows.map(normalizeRow),
  };
  if (rows.length === maxRows) {
    result.result_is_likely_truncated = true;
  }
  return result;
}

/**
 * Runs one `execute_sql` call.
 *
 * The SQL text comes from the model, so the write mode is the only thing
 * standing between a prompt and a destructive statement. No failure throws: a
 * tool reports an error to the model as its result.
 */
async function executeSql(
  deps: BigQueryToolDependencies,
  input: z.infer<typeof EXECUTE_SQL_PARAMETERS>,
  toolContext?: Context,
): Promise<ExecuteSqlResult> {
  const settings = deps.settings;
  if (
    settings.computeProjectId &&
    input.project_id !== settings.computeProjectId
  ) {
    return bigQueryToolError(
      `Cannot execute query in the project ${input.project_id}, as the tool` +
        ' is restricted to execute queries only in the project' +
        ` ${settings.computeProjectId}.`,
    );
  }
  try {
    const client = getBigQueryClient({
      project: input.project_id,
      authClient: deps.credentials,
      location: settings.location,
      userAgent: [settings.applicationName, EXECUTE_SQL_TOOL_NAME],
    });
    const request: Query = {query: input.query, labels: jobLabels(deps)};
    const refusal = await guardWriteMode(
      client,
      request,
      settings.writeMode,
      toolContext,
    );
    if (refusal) {
      return refusal;
    }
    if (input.dry_run) {
      const [job] = await client.createQueryJob({...request, dryRun: true});
      const dryRunInfo: JobMetadata = job.metadata;
      return {status: BigQueryToolStatus.SUCCESS, dry_run_info: dryRunInfo};
    }
    if (settings.maximumBytesBilled) {
      request.maximumBytesBilled = String(settings.maximumBytesBilled);
    }
    return await runQuery(client, request, settings.maxQueryResultRows);
  } catch (error: unknown) {
    return toBigQueryToolError(error);
  }
}

/**
 * Builds the `execute_sql` tool.
 *
 * @param deps The credentials and settings of the owning toolset.
 * @return The tool, described for the write mode the settings name.
 */
export function createExecuteSqlTool(
  deps: BigQueryToolDependencies,
): FunctionTool<typeof EXECUTE_SQL_PARAMETERS> {
  return new FunctionTool({
    name: toolName(deps, EXECUTE_SQL_TOOL_NAME),
    description: executeSqlDescription(deps.settings.writeMode),
    parameters: EXECUTE_SQL_PARAMETERS,
    execute: (input, toolContext) => executeSql(deps, input, toolContext),
  });
}
