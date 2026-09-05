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

// Only what a caller configuring or reading a `SpannerToolset` names. The
// validators run from the constructor, and the tool definitions, the name
// prefix and the credentials manager stay internal to this module.
export * from './admin_toolset.js';
export type {SpannerAuthClient} from './client.js';
export {
  APPROXIMATE_NEAREST_NEIGHBORS,
  Capabilities,
  EXACT_NEAREST_NEIGHBORS,
  QueryResultMode,
} from './settings.js';
export type {
  NearestNeighborsAlgorithm,
  SpannerToolSettings,
  SpannerVectorStoreSettings,
} from './settings.js';
export {SPANNER_DEFAULT_SCOPES} from './spanner_credentials.js';
// The `@google/adk` barrel already publishes a class of this name, a second
// port of the same adk-python type, so the declaration here carries a longer
// one. This subpath is a separate namespace and keeps the short name.
export type {SpannerToolsetCredentialsConfig as SpannerCredentialsConfig} from './spanner_credentials.js';
export * from './spanner_toolset.js';
export type {SpannerToolResult} from './tool_result.js';
