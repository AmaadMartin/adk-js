/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The BigQuery toolset and the types it takes.
 *
 * Node only: the tools reach BigQuery and Dataplex through optional peer
 * dependencies that do not run in a browser, so this barrel is exported from
 * `core/src/index.ts` and not from `core/src/common.ts`.
 */

export {
  BIGQUERY_DEFAULT_SCOPE,
  BIGQUERY_SCOPES,
  BIGQUERY_TOKEN_CACHE_KEY,
  resolveBigQueryScopes,
  type BigQueryCredentialsConfig,
} from './bigquery_credentials.js';
export {
  BigQueryToolset,
  type BigQueryToolsetOptions,
} from './bigquery_toolset.js';
export {
  BQ_USER_AGENT,
  BigQueryClientCache,
  DP_USER_AGENT,
  USER_AGENT_BASE,
  buildUserAgent,
  getBigQueryClient,
  getDataplexCatalogClient,
  type BigQueryClientOptions,
  type BigQueryToolDeps,
} from './client.js';
export {
  DEFAULT_MAX_QUERY_RESULT_ROWS,
  MAX_JOB_LABELS,
  MINIMUM_BYTES_BILLED,
  RESERVED_JOB_LABEL_PREFIX,
  WriteMode,
  createBigQueryToolConfig,
  type BigQueryToolConfig,
  type ResolvedBigQueryToolConfig,
} from './config.js';
export {
  askDataInsights,
  type AskDataInsightsResult,
} from './data_insights_tool.js';
export {
  getDatasetInfo,
  getJobInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
} from './metadata_tool.js';
export {
  BIGQUERY_SESSION_INFO_KEY,
  analyzeContribution,
  detectAnomalies,
  executeSql,
  forecast,
  type BigQueryDryRunResult,
  type BigQueryRow,
  type BigQueryRowsResult,
  type BigQuerySessionInfo,
  type ExecuteSqlResult,
} from './query_tool.js';
export {executeSqlDescription} from './query_tool_descriptions.js';
export {
  searchCatalog,
  type SearchCatalogEntry,
  type SearchCatalogResult,
} from './search_tool.js';
export {
  bigQueryToolError,
  isBigQueryToolError,
  runBigQueryTool,
  type BigQueryToolError,
  type BigQueryToolResult,
} from './tool_result.js';
