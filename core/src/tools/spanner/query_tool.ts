/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {
  databaseParameters,
  databaseTarget,
  rejectPostgresql,
  withSpannerDatabase,
} from './client.js';
import {rowObject, rowValues, toSerializable} from './result_rows.js';
import {
  DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS,
  QueryResultMode,
  SpannerToolSettings,
} from './settings.js';
import {
  SpannerTool,
  SpannerToolFactoryOptions,
  SpannerToolStatus,
} from './spanner_tool.js';

const executeSqlParameters = z.object({
  ...databaseParameters,
  query: z.string().describe('The Spanner SQL query to run.'),
});

const DESCRIPTION_PREFIX =
  'Run a read-only Spanner SQL query and return the result. The query runs ' +
  'in a read-only transaction. When the result carries ' +
  '"result_is_likely_truncated": true, more rows match than were returned.';

/** The row shape each query result mode documents to the model. */
const RESULT_SHAPE_DESCRIPTION: Record<QueryResultMode, string> = {
  [QueryResultMode.DEFAULT]:
    ' Each row is returned as the list of its column values.',
  [QueryResultMode.DICT_LIST]:
    ' Each row is returned as an object keyed by column name.',
};

/** The row cap in force, falling back when the setting is not positive. */
function maxResultRows(settings: SpannerToolSettings): number {
  return settings.maxExecutedQueryResultRows > 0
    ? settings.maxExecutedQueryResultRows
    : DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS;
}

/**
 * Builds the `execute_sql` tool, describing the row shape the configured
 * {@link QueryResultMode} produces.
 */
export function createExecuteSqlTool(
  options: SpannerToolFactoryOptions,
): SpannerTool {
  const mode = options.toolSettings.queryResultMode;
  return SpannerTool.create({
    ...options,
    name: 'execute_sql',
    description: DESCRIPTION_PREFIX + RESULT_SHAPE_DESCRIPTION[mode],
    parameters: executeSqlParameters,
    execute: ({args, credentials, settings}) =>
      withSpannerDatabase(
        databaseTarget(args, credentials, settings.databaseRole),
        async (db) => {
          const rejection = await rejectPostgresql(db);
          if (rejection) {
            return rejection;
          }
          const asObjects =
            settings.queryResultMode === QueryResultMode.DICT_LIST;
          const rows: unknown[] = [];
          let remaining = maxResultRows(settings);
          let truncated = false;
          // Streaming stops at the cap instead of buffering a whole result
          // set the tool would then throw away.
          for await (const row of db.runStream({
            sql: args.query,
            json: asObjects,
          })) {
            rows.push(
              toSerializable(asObjects ? rowObject(row) : rowValues(row)),
            );
            remaining -= 1;
            if (remaining <= 0) {
              truncated = true;
              break;
            }
          }
          return truncated
            ? {
                status: SpannerToolStatus.SUCCESS,
                rows,
                result_is_likely_truncated: true,
              }
            : {status: SpannerToolStatus.SUCCESS, rows};
        },
      ),
  });
}
