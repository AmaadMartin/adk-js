/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@google/adk/tools/spanner` subpath: the Cloud Spanner tools only, without
 * the full ADK barrel. Also re-exported from `@google/adk`.
 *
 * The tools need the optional peer dependency `@google-cloud/spanner`, which
 * they load on first use.
 */

export {
  createGetTableSchemaTool,
  createListNamedSchemasTool,
  createListTableIndexColumnsTool,
  createListTableIndexesTool,
  createListTableNamesTool,
} from './metadata_tool.js';
export {createExecuteSqlTool} from './query_tool.js';
export {
  createSimilaritySearchTool,
  createVectorStoreSimilaritySearchTool,
} from './search_tool.js';
export {
  APPROXIMATE_NEAREST_NEIGHBORS,
  Capabilities,
  DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS,
  EXACT_NEAREST_NEIGHBORS,
  QueryResultMode,
  SpannerToolSettings,
  SpannerVectorStoreSettings,
} from './settings.js';
export type {
  NearestNeighborsAlgorithm,
  SpannerToolSettingsOptions,
  SpannerVectorStoreSettingsOptions,
} from './settings.js';
export {
  SPANNER_DEFAULT_SCOPES,
  SPANNER_TOKEN_CACHE_KEY,
  SpannerCredentialsConfig,
  SpannerCredentialsManager,
} from './spanner_credentials.js';
export type {
  CachedSpannerToken,
  SpannerCredentialsConfigOptions,
} from './spanner_credentials.js';
export {SpannerTool, SpannerToolStatus} from './spanner_tool.js';
export type {
  SpannerErrorResult,
  SpannerResultsResult,
  SpannerRowsResult,
  SpannerToolCall,
  SpannerToolExecute,
  SpannerToolFactoryOptions,
  SpannerToolOptions,
  SpannerToolParameters,
  SpannerToolResult,
} from './spanner_tool.js';
export {
  DEFAULT_SPANNER_TOOL_NAME_PREFIX,
  SpannerToolset,
} from './spanner_toolset.js';
export type {
  SpannerToolPredicate,
  SpannerToolsetOptions,
} from './spanner_toolset.js';
