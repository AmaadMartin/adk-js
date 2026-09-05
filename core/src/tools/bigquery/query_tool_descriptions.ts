/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `execute_sql` instructions the model is shown, one set per write mode.
 *
 * adk-python clones `execute_sql` per {@link WriteMode} and replaces the
 * docstring, because the docstring is what the model reads as the tool
 * contract. In adk-js a tool's description is an option, so
 * {@link executeSqlDescription} selects the string instead. Ported from
 * `_execute_sql_write_mode` and `_execute_sql_protected_write_mode` in
 * adk-python `src/google/adk/integrations/bigquery/query_tool.py`
 * (branch `main`).
 */

import {WriteMode} from './config.js';

/** The part every write mode shares. */
const COMMON_DESCRIPTION =
  'Run a BigQuery or BigQuery ML SQL query in the project and return the ' +
  'result.\n\n' +
  'When `dry_run` is false the result carries a `rows` list. A ' +
  '`result_is_likely_truncated` field set to true means more rows match the ' +
  'query than were returned. When `dry_run` is true the query is validated ' +
  'but not run, and the result carries a `dry_run_info` field describing it.';

/** What the model may run in {@link WriteMode.BLOCKED}. */
const BLOCKED_DESCRIPTION =
  `${COMMON_DESCRIPTION}\n\n` +
  'Only a SELECT statement is accepted. Any other statement is refused.';

/** What the model may run in {@link WriteMode.PROTECTED}. */
const PROTECTED_DESCRIPTION =
  `${COMMON_DESCRIPTION}\n\n` +
  'Notes:\n' +
  '- Only a temporary table or a temporary model can be created, inserted ' +
  'into, or dropped. Do not create, insert into or drop a permanent ' +
  '(non-TEMP) table or model.\n' +
  '- To overwrite an existing temporary table, either use "CREATE OR ' +
  'REPLACE TEMP TABLE" instead of "CREATE TEMP TABLE", or run "DROP TABLE" ' +
  'first.\n' +
  '- To overwrite an existing temporary model, either use "CREATE OR ' +
  'REPLACE TEMP MODEL" instead of "CREATE TEMP MODEL", or run "DROP MODEL" ' +
  'first.';

/** What the model may run in {@link WriteMode.ALLOWED}. */
const ALLOWED_DESCRIPTION =
  `${COMMON_DESCRIPTION}\n\n` +
  'Notes:\n' +
  '- To overwrite an existing destination table, either use "CREATE OR ' +
  'REPLACE TABLE" instead of "CREATE TABLE", or run "DROP TABLE" first.\n' +
  '- To overwrite an existing model, either use "CREATE OR REPLACE MODEL" ' +
  'instead of "CREATE MODEL", or run "DROP MODEL" first.';

/** The description of each write mode, keyed by mode. */
const DESCRIPTIONS: Readonly<Record<WriteMode, string>> = {
  [WriteMode.BLOCKED]: BLOCKED_DESCRIPTION,
  [WriteMode.PROTECTED]: PROTECTED_DESCRIPTION,
  [WriteMode.ALLOWED]: ALLOWED_DESCRIPTION,
};

/**
 * Returns the `execute_sql` instructions for a write mode.
 *
 * @param writeMode The mode the toolset runs in.
 * @return The description the model is shown.
 */
export function executeSqlDescription(writeMode: WriteMode): string {
  return DESCRIPTIONS[writeMode];
}
