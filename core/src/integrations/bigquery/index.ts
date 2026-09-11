/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * First-party BigQuery tools (Experimental).
 *
 * These tools are hand crafted, unlike the generated tools under
 * `tools/google_api_tool`, so an agent gets one integrated way to read
 * BigQuery metadata, run SQL under a write-mode guardrail, and use BigQuery's
 * forecasting and anomaly analyses, with the developer in control of the
 * credentials and the row cap.
 *
 * The entry point is `@google/adk/integrations/bigquery` rather than the
 * package barrel, as the Spanner tools are: it keeps the optional BigQuery
 * peer dependencies out of the main entry point, and the barrel already
 * exports a different, Discovery-generated `BigQueryToolset`.
 *
 * The surface below mirrors what adk-python's `integrations.bigquery` package
 * exports. The individual tool functions stay internal to the toolset.
 */

export {
  BIGQUERY_SCOPES,
  BIGQUERY_TOKEN_CACHE_KEY,
  BigQueryCredentialsConfig,
  type BigQueryCredentialsConfigOptions,
} from './bigquery_credentials.js';
export {
  BigQueryToolset,
  type BigQueryToolsetOptions,
} from './bigquery_toolset.js';
export {
  DEFAULT_MAX_QUERY_RESULT_ROWS,
  MAX_JOB_LABELS,
  MINIMUM_BYTES_BILLED,
  RESERVED_JOB_LABEL_PREFIX,
  WriteMode,
  bigQueryToolConfigSchema,
  createBigQueryToolSettings,
  type BigQueryToolConfig,
  type BigQueryToolSettings,
} from './config.js';
export {BIGQUERY_SESSION_INFO_KEY} from './query_tool.js';
