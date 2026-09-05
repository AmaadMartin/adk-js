/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The BigQuery toolset, the types it takes and the results its tools return.
 *
 * The tool functions themselves, the clients and the SQL helpers stay
 * internal: a caller reaches them through the toolset.
 *
 * Node only: the tools reach BigQuery and Dataplex through optional peer
 * dependencies that do not run in a browser, so this barrel is exported from
 * `core/src/index.ts` and not from `core/src/common.ts`.
 */

export {
  BIGQUERY_SCOPES,
  type BigQueryCredentialsConfig,
} from './bigquery_credentials.js';
export {
  BigQueryToolset,
  type BigQueryToolsetOptions,
} from './bigquery_toolset.js';
export {
  WriteMode,
  createBigQueryToolConfig,
  type BigQueryToolConfig,
  // In `createBigQueryToolConfig`'s signature, so it has to be public too.
  type ResolvedBigQueryToolConfig,
} from './config.js';
export {type AskDataInsightsResult} from './data_insights_tool.js';
export {
  BIGQUERY_SESSION_INFO_KEY,
  type BigQueryDryRunResult,
  type BigQueryRow,
  type BigQueryRowsResult,
  type BigQuerySessionInfo,
  type ExecuteSqlResult,
} from './query_tool.js';
export {
  type SearchCatalogEntry,
  type SearchCatalogResult,
} from './search_tool.js';
export {
  isBigQueryToolError,
  type BigQueryToolError,
  type BigQueryToolResult,
} from './tool_result.js';
