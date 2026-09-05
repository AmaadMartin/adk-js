/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {BigQueryCredentials} from './bigquery_credentials.js';
import {BigQueryToolError, toBigQueryToolError} from './bigquery_tool.js';
import {getBigQueryClient} from './client.js';

/** How many result rows a single `execute_sql` call downloads at most. */
export const MAX_DOWNLOADED_QUERY_RESULT_ROWS = 50;

/** Arguments of {@link executeSql}. */
export const EXECUTE_SQL_PARAMETERS = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the query should be executed.'),
  query: z.string().describe('The BigQuery SQL query to be executed.'),
});

/** Model-facing description of {@link executeSql}. */
export const EXECUTE_SQL_DESCRIPTION =
  'Run a BigQuery SQL query in the project and return the result. If the ' +
  'result contains the key "result_is_likely_truncated" with value true, ' +
  'there may be additional rows matching the query that are not in the ' +
  'result.';

/**
 * The rows a query returned.
 *
 * The keys are model-facing and stay `snake_case`, matching adk-python.
 */
export interface ExecuteSqlResult {
  rows: Array<Record<string, unknown>>;
  /**
   * Present and `true` when the row count hit
   * {@link MAX_DOWNLOADED_QUERY_RESULT_ROWS}, so further matching rows may
   * exist. Absent otherwise.
   */
  result_is_likely_truncated?: true;
}

/**
 * Runs a BigQuery SQL query and returns at most
 * {@link MAX_DOWNLOADED_QUERY_RESULT_ROWS} rows.
 *
 * @param input The project to bill and the query to run.
 * @param credentials The credential to call BigQuery with.
 * @return The rows, or the error payload.
 */
export async function executeSql(
  input: z.infer<typeof EXECUTE_SQL_PARAMETERS>,
  credentials?: BigQueryCredentials,
): Promise<ExecuteSqlResult | BigQueryToolError> {
  try {
    const client = await getBigQueryClient({
      projectId: input.project_id,
      credentials,
    });
    const [rows] = await client.query(input.query, {
      maxResults: MAX_DOWNLOADED_QUERY_RESULT_ROWS,
    });
    return rows.length === MAX_DOWNLOADED_QUERY_RESULT_ROWS
      ? {rows, result_is_likely_truncated: true}
      : {rows};
  } catch (err: unknown) {
    return toBigQueryToolError(err);
  }
}
