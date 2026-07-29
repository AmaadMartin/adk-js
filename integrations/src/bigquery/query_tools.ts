/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {JobMetadata, Query} from '@google-cloud/bigquery';
import {Context} from '@google/adk';

import {BigQueryToolConfig, WriteMode} from './bigquery_config.js';
import {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {BigQueryToolError, toToolError} from './bigquery_results.js';
import {getBigQueryClient} from './client.js';

const BIGQUERY_SESSION_INFO_KEY = 'bigquery_session_info';

/**
 * A single result row. BigQuery column values are dynamic, so they are
 * narrowed to `unknown` at this boundary rather than left as the SDK's `any`.
 */
export type QueryResultRow = Record<string, unknown>;

/** The BigQuery session id and its anonymous dataset id, in that order. */
type BigQuerySessionInfo = [sessionId: string, datasetId: string];

/** Successful result of {@link executeSql}. */
export interface ExecuteSqlSuccess {
  status: 'SUCCESS';
  /** The result rows. Absent for a dry run. */
  rows?: QueryResultRow[];
  /** Job metadata returned instead of rows when `dryRun` is true. */
  dry_run_info?: JobMetadata;
  /** Set when the result was capped by `maxQueryResultRows`. */
  result_is_likely_truncated?: boolean;
}

/** The result of {@link executeSql}. */
export type ExecuteSqlResult = ExecuteSqlSuccess | BigQueryToolError;

/**
 * Unwraps the `{value: ...}` envelope that the BigQuery client puts around
 * some native types (for example DATE and TIME) so the row serializes to
 * plain JSON.
 */
function unwrapRow(row: QueryResultRow): QueryResultRow {
  const out: QueryResultRow = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
  }
  return out;
}

export async function executeSql(
  projectId: string,
  query: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
  toolContext?: Context,
  dryRun = false,
): Promise<ExecuteSqlResult> {
  try {
    if (settings?.computeProjectId && projectId !== settings.computeProjectId) {
      return {
        status: 'ERROR',
        error_details: `Cannot execute query in the project ${projectId}, as the tool is restricted to execute queries only in the project ${settings.computeProjectId}.`,
      };
    }

    const bqClient = getBigQueryClient(
      projectId,
      credentialsConfig,
      settings,
      'execute_sql',
    );

    const jobLabels: Record<string, string> = {...(settings?.jobLabels || {})};
    jobLabels['adk-bigquery-tool'] = 'execute_sql';
    if (settings?.applicationName) {
      jobLabels['adk-bigquery-application-name'] = settings.applicationName;
    }

    let bqSessionId: string | undefined;
    let bqSessionDatasetId: string | undefined;

    if ((settings?.writeMode ?? WriteMode.BLOCKED) === WriteMode.BLOCKED) {
      const [{metadata: dryRunJob}] = await bqClient.createQueryJob({
        query,
        dryRun: true,
        labels: jobLabels,
      });
      if (dryRunJob.statistics?.query?.statementType !== 'SELECT') {
        return {
          status: 'ERROR',
          error_details: 'Read-only mode only supports SELECT statements.',
        };
      }
    } else if (settings?.writeMode === WriteMode.PROTECTED) {
      const sessionInfo = toolContext?.state?.get<BigQuerySessionInfo>(
        BIGQUERY_SESSION_INFO_KEY,
      );
      if (sessionInfo && Array.isArray(sessionInfo)) {
        [bqSessionId, bqSessionDatasetId] = sessionInfo;
      } else {
        const [{metadata: sessionCreatorJob}] = await bqClient.createQueryJob({
          query: 'SELECT 1',
          dryRun: true,
          createSession: true,
          labels: jobLabels,
        });
        bqSessionId = sessionCreatorJob.statistics?.sessionInfo?.sessionId;
        bqSessionDatasetId =
          sessionCreatorJob.configuration?.query?.destinationTable?.datasetId;

        if (toolContext?.state && bqSessionId && bqSessionDatasetId) {
          toolContext.state.set(BIGQUERY_SESSION_INFO_KEY, [
            bqSessionId,
            bqSessionDatasetId,
          ]);
        }
      }

      const connectionProperties = bqSessionId
        ? [{key: 'session_id', value: bqSessionId}]
        : [];

      const [{metadata: dryRunJob}] = await bqClient.createQueryJob({
        query,
        dryRun: true,
        connectionProperties,
        labels: jobLabels,
      });

      const destDatasetId =
        dryRunJob.configuration?.query?.destinationTable?.datasetId;
      if (
        dryRunJob.statistics?.query?.statementType !== 'SELECT' &&
        destDatasetId !== bqSessionDatasetId
      ) {
        return {
          status: 'ERROR',
          error_details:
            'Protected write mode only supports SELECT statements, or write operations in the anonymous dataset of a BigQuery session.',
        };
      }
    }

    const connectionProperties = bqSessionId
      ? [{key: 'session_id', value: bqSessionId}]
      : [];

    if (dryRun) {
      const [{metadata: dryRunJob}] = await bqClient.createQueryJob({
        query,
        dryRun: true,
        connectionProperties,
        labels: jobLabels,
      });
      return {status: 'SUCCESS', dry_run_info: dryRunJob};
    }

    const queryOptions: Query = {
      query,
      connectionProperties,
      labels: jobLabels,
    };
    if (settings?.maximumBytesBilled) {
      // `IJobConfigurationQuery.maximumBytesBilled` is an int64 REST field and
      // is therefore declared as a string by the SDK.
      queryOptions.maximumBytesBilled = String(settings.maximumBytesBilled);
    }

    // Push the row cap into the request. `query()` forwards `maxResults` to
    // `job.getQueryResults()`, where the paginator treats it as a hard cap and
    // stops fetching pages; without it the client auto-paginates the whole
    // result set into memory first.
    const [rows] = await bqClient.query(queryOptions, {
      maxResults: settings?.maxQueryResultRows,
    });

    const result: ExecuteSqlSuccess = {
      status: 'SUCCESS',
      rows: rows.map(unwrapRow),
    };

    if (
      settings?.maxQueryResultRows !== undefined &&
      rows.length >= settings.maxQueryResultRows
    ) {
      // The cap was reached, so there may be more rows that were not fetched.
      // "Likely" because a result of exactly this size is indistinguishable
      // from a truncated one.
      result.result_is_likely_truncated = true;
    }

    return result;
  } catch (error) {
    return toToolError(error);
  }
}
