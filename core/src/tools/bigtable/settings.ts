/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';

/** How many rows a query returns when the caller names no cap. */
export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/** Options accepted by {@link BigtableToolSettings}. */
export interface BigtableToolSettingsOptions {
  /** Maximum number of rows to return from a query result. */
  maxQueryResultRows?: number;
}

/** Settings for the Bigtable tools (Experimental). */
@experimental
export class BigtableToolSettings {
  /** Maximum number of rows to return from a query result. */
  readonly maxQueryResultRows: number;

  constructor(options: BigtableToolSettingsOptions = {}) {
    this.maxQueryResultRows =
      options.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS;
  }
}
