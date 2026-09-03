/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';

/** Maximum number of rows a Bigtable query result returns by default. */
const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/** Settings for Bigtable tools. */
export interface BigtableToolSettings {
  /** Maximum number of rows to return from a query result. Defaults to 50. */
  maxQueryResultRows: number;
}

/**
 * Creates a {@link BigtableToolSettings} with default values.
 *
 * @param params Optional partial {@link BigtableToolSettings} overriding
 *     defaults.
 * @returns A merged {@link BigtableToolSettings} object.
 * @throws {Error} When the `BIGTABLE_TOOL_SETTINGS` feature is disabled.
 */
export function createBigtableToolSettings(
  params: Partial<BigtableToolSettings> = {},
): BigtableToolSettings {
  if (!isFeatureEnabled(FeatureName.BIGTABLE_TOOL_SETTINGS)) {
    throw new Error(
      `Feature ${FeatureName.BIGTABLE_TOOL_SETTINGS} is not enabled.`,
    );
  }
  // A non-positive row cap is stored verbatim. The Bigtable query tool, not
  // this module, substitutes its own limit for such a value.
  return {
    maxQueryResultRows:
      params.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS,
  };
}
