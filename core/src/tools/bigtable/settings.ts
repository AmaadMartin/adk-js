/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** How many rows a query returns when the caller names no cap. */
export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/** Settings for the Bigtable tools. */
export interface BigtableToolSettings {
  /**
   * Maximum number of rows to return from a query result. Defaults to
   * {@link DEFAULT_MAX_QUERY_RESULT_ROWS}.
   */
  maxQueryResultRows?: number;
}
