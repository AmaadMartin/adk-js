/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@google/adk/tools/spanner` subpath: the Spanner admin tools only, without
 * the full ADK barrel. Also re-exported from `@google/adk`.
 */

export * from './admin_toolset.js';
export {
  SPANNER_DEFAULT_SCOPES,
  SPANNER_TOKEN_CACHE_KEY,
  SpannerCredentialsManager,
  validateSpannerCredentialsConfig,
} from './spanner_credentials.js';
export type {SpannerCredentialsConfig} from './spanner_credentials.js';
// Only the types the public signatures name. The seven operations and the name
// prefix stay internal to this module.
export type {SpannerToolResult} from './admin_tool.js';
export type {SpannerAuthClient} from './client.js';
