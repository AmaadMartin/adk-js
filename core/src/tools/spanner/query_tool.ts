/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {withSnapshot} from './client.js';
import {SpannerRow, toJsonSafe, toValueRow} from './result_rows.js';
import {
  DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS,
  QueryResultMode,
  SpannerToolSettings,
} from './settings.js';
import {
  rejectPostgresql,
  SpannerToolDefinition,
  UNSUPPORTED_DIALECT,
} from './spanner_tool.js';

const executeSqlParams = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the Spanner database resides.'),
  instance_id: z.string().describe('The Spanner instance id.'),
  database_id: z.string().describe('The Spanner database id.'),
  query: z.string().describe('The Spanner SQL query to execute.'),
});

const DESCRIPTION_PREFIX =
  'Run a Spanner read-only query and return the result. The query runs in a' +
  ' read-only transaction, so it cannot change any data.';

const DESCRIPTION_SUFFIX =
  ' If the result carries "result_is_likely_truncated", more rows match the' +
  ' query than were returned.';

/** What a row looks like in {@link QueryResultMode.DEFAULT}. */
const DEFAULT_ROW_SHAPE =
  ' Each row is the list of its column values, for example [["The Hotel",' +
  ' 4.1]].';

/** What a row looks like in {@link QueryResultMode.DICT_LIST}. */
const DICT_LIST_ROW_SHAPE =
  ' Each row is an object keyed by column name, for example [{"name": "The' +
  ' Hotel", "rating": 4.1}]. A column the query did not name is keyed "".';

/**
 * Builds the `spanner_execute_sql` tool for one set of settings.
 *
 * The result mode changes what the model is told a row looks like, so the
 * description is part of the settings rather than a constant, matching
 * adk-python's `get_execute_sql`.
 *
 * @param settings The Spanner tool settings.
 * @return The tool definition.
 */
export function getExecuteSqlTool(
  settings: SpannerToolSettings,
): SpannerToolDefinition<typeof executeSqlParams> {
  const dictList = settings.queryResultMode === QueryResultMode.DICT_LIST;
  const maxRows =
    settings.maxExecutedQueryResultRows &&
    settings.maxExecutedQueryResultRows > 0
      ? settings.maxExecutedQueryResultRows
      : DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS;

  return {
    name: 'execute_sql',
    description:
      DESCRIPTION_PREFIX +
      (dictList ? DICT_LIST_ROW_SHAPE : DEFAULT_ROW_SHAPE) +
      DESCRIPTION_SUFFIX,
    parameters: executeSqlParams,
    target: (args) => ({
      projectId: args.project_id,
      instanceId: args.instance_id,
      databaseId: args.database_id,
      databaseRole: settings.databaseRole,
    }),
    async run({database, dialect}, args) {
      rejectPostgresql(dialect, UNSUPPORTED_DIALECT);
      return withSnapshot(database, async (snapshot) => {
        const rows: unknown[] = [];
        let budget = maxRows;
        let truncated = false;
        // Streamed rather than buffered, so the row budget bounds what is
        // read from Spanner and not just what is reported.
        const stream: AsyncIterable<SpannerRow> = snapshot.runStream({
          sql: args.query,
          json: dictList,
        });
        for await (const row of stream) {
          rows.push(toJsonSafe(dictList ? row : toValueRow(row)));
          budget -= 1;
          if (budget <= 0) {
            truncated = true;
            break;
          }
        }
        return truncated ? {rows, result_is_likely_truncated: true} : {rows};
      });
    },
  };
}
