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
 * application that never administers Spanner does not carry
 * `@google-cloud/spanner` in its bundle.
 */

// Only what a caller configuring or reading a `SpannerAdminToolset` names. The
// validators run from the constructor, and the tool definitions, the name
// prefix and the credentials manager stay internal to this module.
export * from './admin_toolset.js';
export type {SpannerAuthClient} from './client.js';
export {SPANNER_DEFAULT_SCOPES} from './spanner_credentials.js';
export type {SpannerCredentialsConfig} from './spanner_credentials.js';
export type {SpannerToolResult} from './tool_result.js';
