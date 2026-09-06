/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Settings for the Bigtable tools. */
export interface BigtableToolSettings {
  /**
   * Maximum number of rows a query result may contain. Defaults to
   * {@link DEFAULT_MAX_QUERY_RESULT_ROWS}. A value of zero or less is ignored.
   */
  maxQueryResultRows?: number;
}

/** Row cap applied when {@link BigtableToolSettings.maxQueryResultRows} is unset. */
export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/**
 * Resolves the row cap a query result is truncated at.
 *
 * @param settings The toolset settings, when the developer supplied any.
 * @return The configured cap, or {@link DEFAULT_MAX_QUERY_RESULT_ROWS}.
 */
export function maxQueryResultRows(settings?: BigtableToolSettings): number {
  const configured = settings?.maxQueryResultRows;
  return configured !== undefined && configured > 0
    ? configured
    : DEFAULT_MAX_QUERY_RESULT_ROWS;
}
