/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Rows returned from a data agent query result when nothing else is set. */
export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/** Settings shared by every tool in the {@link DataAgentToolset}. */
export interface DataAgentToolConfig {
  /**
   * Maximum number of rows returned from a query result. Defaults to
   * {@link DEFAULT_MAX_QUERY_RESULT_ROWS}.
   */
  maxQueryResultRows?: number;

  /**
   * The Google Cloud location of the data agent, for example `eu`, `us` or
   * `global`. When omitted, the location is parsed from the data agent
   * resource name, and falls back to `global`.
   */
  location?: string;

  /**
   * A custom Gemini Data Analytics endpoint. It overrides the default and the
   * location-derived endpoints.
   */
  apiEndpoint?: string;
}
