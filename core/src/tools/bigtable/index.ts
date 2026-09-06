/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bigtable tools (experimental).
 *
 * These tools are hand written rather than generated from the API definition,
 * so that an agent gets one integrated way to read Bigtable metadata and run
 * GoogleSQL, with access guardrails the generated tools do not have.
 */

export {
  BIGTABLE_DEFAULT_SCOPES,
  type BigtableCredentialsConfig,
} from './bigtable_credentials.js';
export {
  BigtableToolset,
  type BigtableToolsetOptions,
} from './bigtable_toolset.js';
export {
  DEFAULT_MAX_QUERY_RESULT_ROWS,
  type BigtableToolSettings,
} from './settings.js';
