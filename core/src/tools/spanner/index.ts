/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@google/adk/tools/spanner` subpath: the Spanner tools only, without the
 * full ADK barrel.
 *
 * This is the only entry point. `@google/adk` does not re-export it, so an
 * application that never reads Spanner does not carry `@google-cloud/spanner`
 * in its bundle.
 */

export {
  APPROXIMATE_NEAREST_NEIGHBORS,
  Capabilities,
  EXACT_NEAREST_NEIGHBORS,
  QueryResultMode,
  resolveVectorStoreSettings,
} from './settings.js';
export type {
  NearestNeighborsAlgorithm,
  ResolvedVectorStoreSettings,
  SpannerToolSettings,
  SpannerVectorStoreSettings,
  TableColumn,
  VectorSearchIndexSettings,
} from './settings.js';
export {
  SPANNER_DEFAULT_SCOPES,
  SPANNER_TOKEN_CACHE_KEY,
  SpannerCredentialsManager,
  validateSpannerCredentialsConfig,
} from './spanner_credentials.js';
export type {SpannerCredentialsConfig} from './spanner_credentials.js';
export * from './spanner_toolset.js';
// Only the types the public signatures name. The tool definitions and the
// name prefix stay internal to this module.
export type {SpannerAccessToken, SpannerAuthClient} from './client.js';
export type {SpannerToolResult} from './tool_result.js';
