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
// Only the types the toolset's public signatures name. The seven operations,
// the client provider and the name prefix stay internal to this module.
export type {SpannerToolResult} from './admin_tool.js';
export type {SpannerAdminClientOptions} from './client.js';
