/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bigtable tools (Experimental).
 *
 * These tools are hand crafted, unlike the generated tools under
 * `tools/google_api_tool`, so that an agent gets one integrated way to read
 * Bigtable metadata and run GoogleSQL, with the developer in control of the
 * credentials and the row cap.
 */

export {
  BIGTABLE_DEFAULT_SCOPE,
  BIGTABLE_TOKEN_CACHE_KEY,
  BigtableCredentialsConfig,
  type BigtableCredentialsConfigOptions,
} from './bigtable_credentials.js';
export {
  BigtableToolset,
  DEFAULT_BIGTABLE_TOOL_NAME_PREFIX,
  type BigtableToolsetOptions,
} from './bigtable_toolset.js';
export {
  DEFAULT_MAX_QUERY_RESULT_ROWS,
  type BigtableToolSettings,
} from './settings.js';
