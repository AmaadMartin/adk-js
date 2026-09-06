/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cloud Storage tools (Experimental).
 *
 * These tools are hand crafted, unlike the generated tools under
 * `tools/google_api_tool`, so that an agent gets one integrated way to work
 * with Cloud Storage, with the developer in control of the credentials and of
 * whether the agent may write at all.
 *
 * There are two entry points. `GcsToolset` reads and writes the objects in a
 * bucket, and authenticates the Cloud Storage client itself. `GcsAdminToolset`
 * administers the buckets, and runs the end user's Google consent flow. The
 * bucket functions, the client factories and the auth shim they are built from
 * stay internal: an application configures a toolset and the toolset calls
 * them.
 */

export {type GcsAdminToolResult} from './admin_tool.js';
export {
  // `storage_toolset.js` below already holds the plain name, and both
  // constants are 'gcs'.
  DEFAULT_GCS_TOOL_NAME_PREFIX as DEFAULT_GCS_ADMIN_TOOL_NAME_PREFIX,
  GcsAdminToolset,
  type GcsAdminToolsetOptions,
} from './admin_toolset.js';
export {
  GCS_DEFAULT_SCOPE,
  GCS_TOKEN_CACHE_KEY,
  GcsCredentialsConfig,
  type GcsClientCredentialsConfig,
  type GcsCredentialsConfigOptions,
} from './gcs_credentials.js';
export {
  DEFAULT_GCS_TOOL_SETTINGS,
  GcsCapability,
  type GcsToolSettings,
} from './settings.js';
export {DEFAULT_GCS_TOOL_NAME_PREFIX, GcsToolset} from './storage_toolset.js';
export type {GcsToolsetOptions} from './storage_toolset.js';
